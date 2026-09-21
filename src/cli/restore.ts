import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { CommandContext } from './registry';
import { loadRegistry } from '../kshetra/registry';
import { readPid, isAlive } from './pid';
import { logPath, usagePath, notificationsPath } from '../sthapathi/activity-log';
import { kshetraStateLocations, shreniDir } from '../kshetra/state-locations';
import {
  restoreKshetraSlice,
  getKshetraState,
  type KshetraState,
} from '../kshetra/state';
import { git } from '../sthapathi/git';
import {
  readManifest,
  copyTree,
  moveTree,
  readBeadStats,
  readLastDoltCommit,
  computeSnapshotId,
  SNAPSHOT_SCHEMA_VERSION,
} from '../kshetra/snapshot';
import { appendLedgerEvent } from '../ext/index';

// Filesystem-safe timestamp for the archive dir name (colons/dots break some
// tools). Derived from the clock, never from the snapshot.
function archiveStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// `shreni restore --kshetra <id> --from <dir> --yes [--clean] [--archive <dir>]`
// — put a frozen state back exactly, or fail loudly (epic Shreni-beads-ius, B4.3).
// Destructive and guarded: no --force escape (restoring under a running worker
// corrupts the DB), archive-first so it is reversible, delete-then-copy (never
// bd import, which is an upsert — finding 2), verified against the manifest.
export async function runRestore(ctx: CommandContext): Promise<void> {
  const id = ctx.flag('--kshetra');
  if (!id) throw new Error('restore requires --kshetra <id>.');
  const from = ctx.flag('--from');
  if (!from) throw new Error('restore requires --from <dir>.');
  if (!ctx.has('--yes')) {
    throw new Error('restore is destructive (replaces the beads DB); pass --yes to confirm.');
  }
  const clean = ctx.has('--clean');

  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) throw new Error(`Kshetra not found: ${id}`);

  // Guard 1 — a live worker. No --force: restoring the beads dir under an active
  // dispatch corrupts the Dolt DB mid-write.
  const pid = readPid(id);
  if (pid !== null && isAlive(pid)) {
    throw new Error(
      `Worker for "${id}" is alive (pid ${pid}); restoring under it would corrupt the DB. ` +
        `Stop it first: shreni stop --kshetra ${id}.`,
    );
  }

  // Guards 2–4 — the manifest. readManifest throws on missing/corrupt.
  const manifest = readManifest(from);
  if (manifest.kshetraId !== id) {
    throw new Error(
      `Snapshot is for kshetra "${manifest.kshetraId}", not "${id}" — refusing to cross-restore.`,
    );
  }
  if (manifest.schemaVersion > SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Snapshot schema v${manifest.schemaVersion} is newer than this build (v${SNAPSHOT_SCHEMA_VERSION}); upgrade shreni to restore it.`,
    );
  }

  const locations = kshetraStateLocations(kshetra);
  const byKey = new Map(manifest.locations.map(l => [l.key, l]));

  // ── Archive first (decisions 3/6): move the current state of every location
  // into a timestamped dir so the restore is reversible and the pre-restore
  // audit record (ledger.jsonl, inside the beads dir) is preserved.
  const archiveBase = ctx.flag('--archive') ?? join(shreniDir(), 'archive', id);
  const archiveTo = join(archiveBase, archiveStamp());
  mkdirSync(archiveTo, { recursive: true });

  for (const loc of locations) {
    if (loc.kind === 'json-slice') {
      const current = getKshetraState(kshetra) ?? null;
      writeFileSync(join(archiveTo, `${loc.key}.json`), JSON.stringify(current, null, 2), 'utf8');
      continue;
    }
    if (existsSync(loc.path)) moveTree(loc.path, join(archiveTo, loc.key));
  }

  // ── Restore each location from the snapshot. A location the snapshot did NOT
  // capture is left absent (already archived away) — that reproduces "the frozen
  // kshetra had no RAG index" rather than leaving a stale one behind.
  for (const loc of locations) {
    const entry = byKey.get(loc.key);
    if (loc.kind === 'json-slice') {
      let slice: KshetraState | null = null;
      if (entry?.present && entry.snapshotPath) {
        slice = JSON.parse(readFileSync(join(from, entry.snapshotPath), 'utf8')) as KshetraState;
      }
      restoreKshetraSlice(kshetra, slice); // merges this entry only + clears pause/stuck
      continue;
    }
    // Delete-then-copy (finding 2): archiving already moved the live path away,
    // but clear it unconditionally so `cp` can never nest the snapshot under a
    // surviving directory (e.g. if a cross-device archive move left a remnant).
    rmSync(loc.path, { recursive: true, force: true });
    if (entry?.present && entry.snapshotPath) {
      copyTree(join(from, entry.snapshotPath), loc.path);
    }
  }

  // ── --clean: leave the per-trial feeds empty rather than carrying the
  // snapshot's copies forward (what the study driver wants once it has copied the
  // previous trial's data out). activity/usage/notifications live in the runtime
  // dir; ledger.jsonl lives in the beads dir.
  if (clean) {
    for (const p of [
      logPath(id),
      usagePath(id),
      notificationsPath(id),
      join(kshetra.beads.path, 'ledger.jsonl'),
    ]) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '', 'utf8');
    }
  }

  // Post-restore facts, read once for both the ledger boundary and verification.
  const stats = readBeadStats(kshetra.beads.path);
  let headSha: string | null = null;
  try {
    headSha = await git(kshetra.beads.path).headSha();
  } catch {
    headSha = null;
  }
  const doltCommit = readLastDoltCommit(kshetra.beads.path);
  const slice = getKshetraState(kshetra);

  // Record the restore in the RESTORED ledger, AFTER the restore (and after any
  // --clean wipe) but BEFORE verification. It lands at the boundary between the
  // rewound snapshot entries and whatever runs next, so a rewound ledger is
  // distinguishable from one that simply lost history (shreni show renders it as
  // an explicit marker). Emitted before the verify gate on purpose: the rewind is
  // a physical fact worth recording even when verification then fails — that is
  // exactly the case where an unmarked, rewound ledger would mislead most. With
  // --clean the ledger was emptied, so this is its first entry. Best-effort audit:
  // a ledger write must not fail an otherwise-completed restore.
  const snapshotId = manifest.snapshotId || computeSnapshotId(manifest);
  try {
    appendLedgerEvent(join(kshetra.beads.path, 'ledger.jsonl'), {
      type: 'state_restored',
      kshetra: id,
      snapshotId,
      beadCount: stats.beadCount,
      memoryCount: stats.memoryCount,
      beadsSha: headSha,
      archivePath: archiveTo,
      clean,
    });
  } catch (err) {
    console.error(`warning: could not append state_restored to ledger: ${(err as Error).message}`);
  }

  // ── Verify against the manifest and fail non-zero on ANY mismatch — a silent
  // partial restore would invalidate every trial after it.
  const failures: string[] = [];
  const check = (name: string, ok: boolean, got: unknown, want: unknown) => {
    if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  check('beadCount', stats.beadCount === manifest.beads.beadCount, stats.beadCount, manifest.beads.beadCount);
  check('beadIdHash', stats.beadIdHash === manifest.beads.beadIdHash, stats.beadIdHash, manifest.beads.beadIdHash);
  check('memoryCount', stats.memoryCount === manifest.beads.memoryCount, stats.memoryCount, manifest.beads.memoryCount);
  check('beadsHeadSha', headSha === manifest.beads.headSha, headSha, manifest.beads.headSha);
  check('lastDoltCommit', doltCommit === manifest.beads.lastDoltCommit, doltCommit, manifest.beads.lastDoltCommit);
  check('notPaused', !slice?.paused, slice?.paused ?? false, false);
  check('notStuck', slice?.stuck === undefined, slice?.stuck ?? null, null);

  if (failures.length > 0) {
    throw new Error(
      `restore verification FAILED (state left restored-but-unverified; archive at ${archiveTo}):\n` +
        failures.map(f => `  - ${f}`).join('\n'),
    );
  }

  console.log(
    `restored "${id}" from ${from} — ${stats.beadCount} beads, ${stats.memoryCount} memories` +
      `${clean ? ', per-trial feeds cleaned' : ''}. Archive: ${archiveTo}`,
  );
}
