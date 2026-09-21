import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
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
  MANIFEST_FILENAME,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotLocationEntry,
  type SnapshotManifest,
} from '../kshetra/snapshot';

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

  // Never copy into a non-empty directory: BSD cp would nest the source under an
  // existing same-named child, and a stale manifest would misdescribe the copy.
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`Output directory is not empty: ${out}`);
  }
  mkdirSync(out, { recursive: true });

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
        writeFileSync(join(out, snapshotPath), body, 'utf8');
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
      copyTree(loc.path, join(out, snapshotPath));
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
    kshetraId: id,
    createdAt: new Date().toISOString(),
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

  const manifestPath = join(out, MANIFEST_FILENAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const captured = entries.filter(e => e.present).map(e => e.key);
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  console.log(
    `froze "${id}": ${captured.join(', ')} — ${beadStats.beadCount} beads, ` +
      `${beadStats.memoryCount} memories, ${formatBytes(totalBytes)} → ${manifestPath}`,
  );
}
