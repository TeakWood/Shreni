import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { dirname, join } from 'path';
import type { BuildIdentity } from '../sthapathi/build-info.js';
import type { StateLocationKind, StateLocationRole } from './state-locations.js';

// Shared shreni freeze / restore machinery (epic Shreni-beads-ius). freeze
// (B4.2) copies each state location into a snapshot dir and writes manifest.json;
// restore (B4.3) reads the manifest, verifies it, and puts every location back.
// The manifest shape and the snapshot layout are the contract between them, so
// they live here rather than in either command.

// Bump when the manifest shape or snapshot layout changes incompatibly. restore
// refuses a snapshot whose schemaVersion it does not understand. Version 2 is a
// task graph engine snapshot (the `engine` section, no beads location). Version
// 1 was a copy of the beads directory; restore refuses it, as beads is gone.
export const SNAPSHOT_SCHEMA_VERSION = 2;
export const BEADS_SNAPSHOT_SCHEMA_VERSION = 1;

// The manifest file at the root of a snapshot directory.
export const MANIFEST_FILENAME = 'manifest.json';

// Where a json-slice location's extracted slice is written inside the snapshot
// (the whole global state.json is never copied — finding 3).
export const SLICE_FILE_SUFFIX = '.json';

export interface SnapshotLocationEntry {
  key: string;
  role: StateLocationRole;
  kind: StateLocationKind;
  // The live path this was captured from (recorded so a reader sees the source
  // without re-running the resolver against a possibly-changed config).
  sourcePath: string;
  // Whether the source existed at freeze time. A `required` location that is
  // absent aborts the freeze; optional ones simply record present:false.
  present: boolean;
  // Path RELATIVE to the snapshot dir where this location was captured
  // (e.g. 'runtime', 'flags.json'), or null when absent.
  snapshotPath: string | null;
  // Bytes captured (recursive for a dir, file size for a file, slice JSON size
  // for a json-slice), 0 when absent.
  sizeBytes: number;
  // json-slice only: the object key under state.kshetras this slice belongs to.
  sliceKey?: string;
}

// Verifiable task/memory accounting, from the project's bundle (finding 1: the
// memory count must be counted, never assumed — memories would otherwise leak
// between trials undetected).
export interface BeadStats {
  beadCount: number;
  memoryCount: number;
  openCount: number;
  closedCount: number;
  // sha256 over the sorted bead ids — stable across freezes of an unchanged
  // kshetra, so restore can prove the bead graph came back byte-for-identical.
  beadIdHash: string;
}

export interface SnapshotManifest {
  schemaVersion: number;
  // Stable content id of this snapshot (sha256 over the manifest with this field
  // omitted), so a lot manifest / trial log / ledger entry can name the exact
  // starting state. Two freezes of an unchanged kshetra differ only by createdAt,
  // so the id is snapshot-instance-stable, not state-stable (use beads.beadIdHash
  // for state equality).
  snapshotId: string;
  kshetraId: string;
  // ISO timestamp the snapshot was taken.
  createdAt: string;
  // Which build of Shreni took the snapshot (Shreni-beads-yrk.2).
  shreniBuild: BuildIdentity;
  // The work repo path — RECORDED for provenance, never snapshotted (the driver
  // owns the target repo via git; finding: repo.path is not a state location).
  repoPath: string;
  beads: {
    headSha: string | null;
    lastDoltCommit: string | null;
  } & BeadStats;
  rag: { present: boolean; sizeBytes: number };
  // A Kshetra on the task graph engine: its project's bundle and version (the
  // last event id). `beads` then carries the bundle's task and memory stats.
  engine?: { projectId: string; lastEventId: string | null; eventCount: number; snapshotPath: string };
  // One entry per state location (from kshetraStateLocations), in resolver order.
  locations: SnapshotLocationEntry[];
  // Opaque `--label key=value` metadata passed on the command line, verbatim.
  labels: Record<string, string>;
}

// Total size in bytes of a file or directory (recursive). Missing path → 0.
export function pathSizeBytes(path: string): number {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of readdirSync(path)) {
    total += pathSizeBytes(join(path, name));
  }
  return total;
}

// Copy a file or directory to `dest`, preferring an APFS clone (cp -c) so the
// ~117MB beads dir is captured cheaply, falling back to a plain recursive copy
// where clonefile is unavailable (non-APFS volume, non-macOS). Returns which
// path was taken. The parent of `dest` is created; `dest` itself must not exist
// (BSD cp -R copies src TO dest only when dest is absent).
export function copyTree(src: string, dest: string): 'clone' | 'copy' {
  mkdirSync(dirname(dest), { recursive: true });
  if (process.platform === 'darwin') {
    try {
      // -R recurse, -c clone (clonefile). On a non-APFS volume cp exits non-zero;
      // fall through to the portable copy rather than fail the freeze.
      execFileSync('cp', ['-Rc', src, dest], { stdio: 'ignore' });
      return 'clone';
    } catch {
      // fall through
    }
  }
  cpSync(src, dest, { recursive: true });
  return 'copy';
}

// Move a file or directory to `dest` (archive-first restore, B4.3). Prefers an
// atomic rename (instant, no extra disk — src and dest are usually on the same
// volume); on a cross-device move (EXDEV) falls back to copy-then-remove. The
// parent of `dest` is created. No-op-safe callers should check existsSync(src)
// first — a missing src throws here.
export function moveTree(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

// The stable content id of a manifest: sha256 over its canonical JSON (sorted
// keys) with `snapshotId` itself omitted, so the id never depends on itself. Used
// by freeze to stamp manifest.snapshotId and by restore to recover it from an
// (older) snapshot that predates the field.
export function computeSnapshotId(manifest: Partial<SnapshotManifest>): string {
  const { snapshotId: _omit, ...rest } = manifest;
  return 'snap:' + createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 32);
}

// Canonical JSON with recursively sorted keys, so key order never moves the hash.
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = sort(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

// One subdirectory of a snapshot parent, as seen by a listing / --latest scan.
// A manifest that is missing, corrupt, or schema-newer than this build is
// surfaced as `unreadable` (with a reason) rather than thrown, so one bad
// snapshot never sinks the whole scan.
export interface SnapshotScanEntry {
  // The subdirectory name (e.g. '2026-09-21-143005-warmup').
  dir: string;
  // Absolute path to the subdirectory.
  path: string;
  // The parsed manifest, or null when unreadable.
  manifest: SnapshotManifest | null;
  unreadable: boolean;
  // Why the manifest could not be trusted (set iff unreadable).
  reason?: string;
}

// Scan ONE level of `parent` for subdirectories that contain a manifest.json and
// read each. Subdirs without a manifest are skipped (they are not snapshots). A
// manifest that is corrupt or schema-newer than this build yields an unreadable
// entry rather than throwing. Entries come back sorted by dir name; callers that
// want newest-first re-sort by manifest.createdAt. Throws only if `parent` itself
// cannot be read as a directory.
export function scanSnapshotParent(parent: string): SnapshotScanEntry[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    throw new Error(`Not a directory (cannot list snapshots): ${parent}`);
  }
  const out: SnapshotScanEntry[] = [];
  for (const name of names.sort()) {
    const full = join(parent, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!existsSync(join(full, MANIFEST_FILENAME))) continue;
    let manifest: SnapshotManifest | null = null;
    let unreadable = false;
    let reason: string | undefined;
    try {
      const m = readManifest(full);
      if (typeof m.schemaVersion === 'number' && m.schemaVersion > SNAPSHOT_SCHEMA_VERSION) {
        unreadable = true;
        reason = `schema v${m.schemaVersion} is newer than this build (v${SNAPSHOT_SCHEMA_VERSION})`;
      } else {
        manifest = m;
      }
    } catch (err) {
      unreadable = true;
      reason = (err as Error).message;
    }
    out.push({ dir: name, path: full, manifest, unreadable, reason });
  }
  return out;
}

// Read the snapshot manifest at the root of a snapshot dir. Throws a clear error
// if absent or unparseable (restore's first gate).
export function readManifest(snapshotDir: string): SnapshotManifest {
  const path = join(snapshotDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Not a snapshot directory (no ${MANIFEST_FILENAME}): ${snapshotDir}`);
  }
  try {
    return JSON.parse(raw) as SnapshotManifest;
  } catch (err) {
    throw new Error(`Corrupt ${MANIFEST_FILENAME} in ${snapshotDir}: ${(err as Error).message}`);
  }
}
