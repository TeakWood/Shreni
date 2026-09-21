import { join } from 'path';
import { homedir } from 'os';
import type { KshetraConfig } from './config.js';

// ── Single source of truth for every ~/.shreni path that belongs to a Kshetra ──
//
// Before this module the machine-side layout was convention scattered across
// modules with nothing that enumerated it: `kshetraDir` was defined twice
// (cli/pid.ts and sthapathi/activity-log.ts) and state.json's path twice
// (kshetra/state.ts and phalaka/stream.ts). This file owns those derivations so
// there is exactly one definition of each, and `kshetraStateLocations` below is
// the enumerable answer to "what state belongs to this Kshetra?" that shreni
// freeze / restore (epic Shreni-beads-ius) snapshot and put back.

export function shreniDir(): string {
  return join(homedir(), '.shreni');
}

// The per-Kshetra runtime directory: activity.jsonl, notifications.jsonl,
// usage.jsonl, heartbeat, worker.pid, worker.log — everything keyed by id.
export function kshetraDir(kshetraId: string): string {
  return join(shreniDir(), 'kshetra', kshetraId);
}

// The GLOBAL flags file: every Kshetra's paused/stuck/watchdog entry lives in
// this one file under `.kshetras[<id>]` (src/kshetra/state.ts). A restore must
// therefore rewrite only this Kshetra's slice, never replace the file — see the
// `json-slice` entry in kshetraStateLocations.
export function stateFilePath(): string {
  return join(shreniDir(), 'state.json');
}

// The RAG index is keyed by SLUG, not id. init sets `config.id = opts.slug`
// (cli/init-kshetra.ts), so for a registered Kshetra the id IS the slug — this
// function is the single exposed id→slug mapping (epic finding 4). Callers must
// resolve the RAG path through here rather than assuming id == slug at each site,
// so the mapping stays in one place if the two ever diverge.
export function kshetraRagSlug(kshetra: KshetraConfig): string {
  return kshetra.id;
}

export function ragIndexDir(slug: string): string {
  return join(shreniDir(), 'rag', slug);
}

// Pre-Feature-2 activity log location, kept so `tail` can still read older logs.
export function legacyLogPath(kshetraId: string): string {
  return join(shreniDir(), 'logs', `${kshetraId}.jsonl`);
}

export type StateLocationKind = 'dir' | 'file' | 'json-slice';
export type StateLocationRole = 'beads' | 'runtime' | 'flags' | 'index';

// One piece of a Kshetra's state on this machine.
export interface StateLocation {
  // Stable identifier for this location within a Kshetra (used as the manifest
  // key by freeze/restore). Unique across the returned list.
  key: string;
  // Absolute path to the file or directory.
  path: string;
  kind: StateLocationKind;
  // `dir`/`file`: the whole path is this Kshetra's. `json-slice`: the file is
  // shared across Kshetras and only `sliceKey`'s entry belongs to this one.
  role: StateLocationRole;
  // Whether the location must exist for a valid Kshetra. `beads` is required;
  // the runtime dir, flags slice, RAG index and legacy log are all created
  // lazily and may be absent on a freshly registered Kshetra.
  required: boolean;
  // Present only on `json-slice` entries: the object key under which this
  // Kshetra's state lives in the shared file (`state.kshetras[sliceKey]`). A
  // restore rewrites only this key and leaves other Kshetras' entries intact.
  sliceKey?: string;
}

// Enumerate every state location that belongs to `kshetra`. This is the
// definition of "kshetra state": freeze snapshots each entry (by copy, never by
// re-import — epic finding 2), restore puts each back, and a test guards that no
// new ~/.shreni path can be derived elsewhere without being added here.
//
// `repo.path` is deliberately NOT in this list. The work repo is owned by the
// study driver (git reset --hard / clean), not snapshotted by shreni — the
// design settled that Shreni owns the *state* definition and the driver owns the
// target repo. Freeze records repo.path in its manifest straight from config;
// the resolver only enumerates what shreni itself snapshots.
export function kshetraStateLocations(kshetra: KshetraConfig): StateLocation[] {
  return [
    {
      // The whole beads directory — Dolt DB, issues.jsonl, export-state.json,
      // ledger.jsonl. Snapshotted whole (memories round-trip through here, so a
      // partial rebuild by `bd import` would leak them between trials).
      key: 'beads',
      path: kshetra.beads.path,
      kind: 'dir',
      role: 'beads',
      required: true,
    },
    {
      key: 'runtime',
      path: kshetraDir(kshetra.id),
      kind: 'dir',
      role: 'runtime',
      required: false,
    },
    {
      key: 'flags',
      path: stateFilePath(),
      kind: 'json-slice',
      role: 'flags',
      required: false,
      sliceKey: kshetra.id,
    },
    {
      key: 'rag',
      path: ragIndexDir(kshetraRagSlug(kshetra)),
      kind: 'dir',
      role: 'index',
      required: false,
    },
    {
      key: 'legacy-log',
      path: legacyLogPath(kshetra.id),
      kind: 'file',
      role: 'runtime',
      required: false,
    },
  ];
}
