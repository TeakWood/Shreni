import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CommandContext } from './registry';
import { loadRegistry } from '../kshetra/registry';
import { readPid, isAlive } from './pid';
import { parseLabels } from './labels';
import { loadState } from '../kshetra/state';
import { kshetraStateLocations } from '../kshetra/state-locations';
import { git } from '../sthapathi/git';
import { getBuildIdentity } from '../sthapathi/build-info';
import {
  copyTree,
  pathSizeBytes,
  readBeadStats,
  readLastDoltCommit,
  computeSnapshotId,
  MANIFEST_FILENAME,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotLocationEntry,
  type SnapshotManifest,
} from '../kshetra/snapshot';
import { appendLedgerEvent } from '../ext/index';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

// A filesystem-safe stamp for a snapshot subdirectory name: YYYY-MM-DD-HHMMSS in
// UTC, derived from the same clock instant as the manifest createdAt so the two
// agree. Seconds resolution (the subdir also carries the stage slug for the human
// reader); freeze appends a -N suffix on the rare same-second collision.
function freezeStamp(now: Date): string {
  const iso = now.toISOString(); // 2026-09-21T14:30:05.123Z
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

// Derive a short directory slug from the `--label stage=<value>` when present, so
// a subdir name carries the stage a reader cares about. Sanitised to [a-z0-9-],
// collapsed, trimmed, and bounded — returns null when there is no usable stage.
function slugFromLabels(labels: Record<string, string>): string | null {
  const stage = labels.stage;
  if (!stage) return null;
  const slug = stage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : null;
}

// True for directory entries a snapshot-parent scan ignores (e.g. macOS .DS_Store,
// editor turds). Only hidden entries — anything visible that is not itself a
// snapshot dir means "this is not a snapshot parent", and freeze refuses it.
function isIgnorableEntry(name: string): boolean {
  return name.startsWith('.');
}

// Resolve `--out` into the directory THIS snapshot is written to (epic
// Shreni-beads-qdz).
//   - out absent, or present-and-empty  -> out itself (backward compatible: the
//     snapshot lands directly there, byte-identical to the old behaviour).
//   - out present, non-empty, and every visible entry is a snapshot dir (contains
//     manifest.json) -> treat out as a PARENT and return a timestamped subdir
//     inside it, carrying the stage slug when one was labelled.
//   - out present, non-empty, containing anything else -> throw (never write into
//     a directory whose contents we do not recognise).
export function resolveFreezeOutDir(
  out: string,
  labels: Record<string, string>,
  now: Date,
): string {
  if (!existsSync(out)) return out;
  const entries = readdirSync(out);
  if (entries.length === 0) return out;

  const isSnapshotParent = entries.every(name => {
    if (isIgnorableEntry(name)) return true;
    const full = join(out, name);
    try {
      return statSync(full).isDirectory() && existsSync(join(full, MANIFEST_FILENAME));
    } catch {
      return false;
    }
  });
  if (!isSnapshotParent) {
    throw new Error(
      `Output directory is not empty and is not a snapshot parent: ${out}. ` +
        `It holds entries that are neither snapshot directories nor ignorable — ` +
        `refusing to write into a directory whose contents we do not recognise.`,
    );
  }

  const stamp = freezeStamp(now);
  const slug = slugFromLabels(labels);
  const base = slug ? `${stamp}-${slug}` : stamp;
  // Same-second collision (or a re-used stamp): step to base-2, base-3, … so we
  // never write into an existing, non-empty snapshot subdir.
  let dir = join(out, base);
  let n = 2;
  while (existsSync(dir) && readdirSync(dir).length > 0) {
    dir = join(out, `${base}-${n++}`);
  }
  return dir;
}

// `shreni freeze --kshetra <id> --out <dir> [--label k=v ...] [--force]` —
// capture a kshetra's complete state (epic Shreni-beads-ius, B4.2). Snapshot by
// copy (never by re-import — finding 2), extract only this kshetra's state.json
// slice (finding 3), and write a verifiable manifest.json.
export async function runFreeze(ctx: CommandContext): Promise<void> {
  const id = ctx.flag('--kshetra');
  if (!id) throw new Error('freeze requires --kshetra <id>.');
  const out = ctx.flag('--out');
  if (!out) throw new Error('freeze requires --out <dir>.');
  const force = ctx.has('--force');
  // Validated up front so a malformed --label fails before any copy.
  const labels = parseLabels(ctx.args);

  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) throw new Error(`Kshetra not found: ${id}`);

  // A snapshot taken while the worker is dispatching is torn (mid-write beads
  // DB, half-flushed activity log). Refuse unless the operator forces it.
  const pid = readPid(id);
  if (pid !== null && isAlive(pid) && !force) {
    throw new Error(
      `Worker for "${id}" is alive (pid ${pid}); a mid-dispatch snapshot is torn. ` +
        `Stop it first (shreni stop --kshetra ${id}) or pass --force.`,
    );
  }

  // Resolve --out: fresh/empty dir → write there (as before); a directory of
  // existing snapshots → a fresh timestamped subdir inside it; anything else → a
  // hard error (never nest a copy under an unrecognised directory). One clock
  // instant drives both the subdir stamp and the manifest createdAt.
  const now = new Date();
  const resolvedOut = resolveFreezeOutDir(out, labels, now);
  mkdirSync(resolvedOut, { recursive: true });

  const locations = kshetraStateLocations(kshetra);
  const entries: SnapshotLocationEntry[] = [];

  for (const loc of locations) {
    if (loc.kind === 'json-slice') {
      // Extract ONLY this kshetra's slice of the shared state.json — never the
      // whole global file (which holds every other kshetra's flags).
      const slice = loadState().kshetras[loc.sliceKey ?? id] ?? null;
      const present = slice !== null;
      let snapshotPath: string | null = null;
      let sizeBytes = 0;
      if (present) {
        snapshotPath = `${loc.key}.json`;
        const body = JSON.stringify(slice, null, 2);
        writeFileSync(join(resolvedOut, snapshotPath), body, 'utf8');
        sizeBytes = Buffer.byteLength(body, 'utf8');
      }
      entries.push({
        key: loc.key,
        role: loc.role,
        kind: loc.kind,
        sourcePath: loc.path,
        present,
        snapshotPath,
        sizeBytes,
        sliceKey: loc.sliceKey,
      });
      continue;
    }

    const present = existsSync(loc.path);
    if (!present && loc.required) {
      throw new Error(`Required state location "${loc.key}" is missing: ${loc.path}`);
    }
    let snapshotPath: string | null = null;
    let sizeBytes = 0;
    if (present) {
      snapshotPath = loc.key;
      copyTree(loc.path, join(resolvedOut, snapshotPath));
      sizeBytes = pathSizeBytes(loc.path);
    }
    entries.push({
      key: loc.key,
      role: loc.role,
      kind: loc.kind,
      sourcePath: loc.path,
      present,
      snapshotPath,
      sizeBytes,
    });
  }

  // beads HEAD is best-effort provenance: a beads dir that is not a git checkout
  // records null rather than failing the freeze.
  let headSha: string | null = null;
  try {
    headSha = await git(kshetra.beads.path).headSha();
  } catch {
    headSha = null;
  }

  const beadStats = readBeadStats(kshetra.beads.path);
  const ragEntry = entries.find(e => e.key === 'rag');

  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: '', // filled in below once the rest of the manifest is assembled
    kshetraId: id,
    createdAt: now.toISOString(),
    shreniBuild: getBuildIdentity(),
    repoPath: kshetra.repo.path,
    beads: {
      headSha,
      lastDoltCommit: readLastDoltCommit(kshetra.beads.path),
      ...beadStats,
    },
    rag: {
      present: ragEntry?.present ?? false,
      sizeBytes: ragEntry?.sizeBytes ?? 0,
    },
    locations: entries,
    labels,
  };
  manifest.snapshotId = computeSnapshotId(manifest);

  const manifestPath = join(resolvedOut, MANIFEST_FILENAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Record the freeze in the LIVE ledger (best-effort audit — a ledger write must
  // never fail the snapshot). The snapshot's own ledger.jsonl was copied before
  // this line, so it records state as-of freeze, not its own state_frozen entry.
  try {
    appendLedgerEvent(join(kshetra.beads.path, 'ledger.jsonl'), {
      type: 'state_frozen',
      kshetra: id,
      snapshotId: manifest.snapshotId,
      beadCount: beadStats.beadCount,
      memoryCount: beadStats.memoryCount,
      beadsSha: headSha,
      labels,
    });
  } catch (err) {
    console.error(`warning: could not append state_frozen to ledger: ${(err as Error).message}`);
  }

  const captured = entries.filter(e => e.present).map(e => e.key);
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

  // --json: emit the machine-readable facts a study driver needs — above all the
  // RESOLVED directory, which differs from --out whenever --out was a parent.
  if (ctx.has('--json')) {
    console.log(
      JSON.stringify({
        kshetraId: id,
        outDir: resolvedOut,
        manifestPath,
        snapshotId: manifest.snapshotId,
        beadCount: beadStats.beadCount,
        memoryCount: beadStats.memoryCount,
        beadIdHash: beadStats.beadIdHash,
        totalBytes,
        labels,
      }),
    );
    return;
  }

  // When --out resolved to a timestamped subdir, name it so a human sees where
  // the snapshot actually landed (not just the parent they passed).
  const target = resolvedOut === out ? manifestPath : `${resolvedOut}/ (${MANIFEST_FILENAME})`;
  console.log(
    `froze "${id}": ${captured.join(', ')} — ${beadStats.beadCount} beads, ` +
      `${beadStats.memoryCount} memories, ${formatBytes(totalBytes)} → ${target}`,
  );
}
