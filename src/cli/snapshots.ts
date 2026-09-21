import { makeContext, type CommandContext } from './registry';
import type { BuildIdentity } from '../sthapathi/build-info';
import { pathSizeBytes, scanSnapshotParent, type SnapshotManifest } from '../kshetra/snapshot';

// `shreni snapshots list <parent> [--kshetra <id>] [--json]` (epic
// Shreni-beads-qdz) — make a growing pile of freeze snapshots legible without
// cat-ing manifest.json files. Scans one level under <parent>, reads each
// manifest (never the payload), and prints one row per snapshot newest-first.
//
// The one subtlety the listing must get right: snapshotId is instance-stable, not
// state-stable (it hashes createdAt), so two freezes of the SAME kshetra state
// have DIFFERENT snapshotIds. beads.beadIdHash is the state identity. So "which of
// these is the same starting state?" is answered by beadIdHash, and the listing
// tags rows that share one with a common marker (S1, S2, …) rather than inviting
// the reader to compare snapshotIds.

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

// version@commit7(+dirty) from a manifest's shreniBuild, mirroring `shreni show`.
function formatBuild(b: BuildIdentity | undefined): string {
  if (!b) return '?';
  const version = b.version || '?';
  const commit =
    typeof b.commit === 'string' && b.commit.length > 0
      ? b.commit === 'unknown'
        ? 'unknown'
        : b.commit.slice(0, 7)
      : 'null';
  return `${version}@${commit}${b.dirty === true ? ' (dirty)' : ''}`;
}

// The state-identity hash, shortened for the table (drop the 'sha256:' prefix).
function shortHash(beadIdHash: string | undefined): string {
  if (!beadIdHash) return '?';
  return beadIdHash.replace(/^sha256:/, '').slice(0, 12);
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

interface SnapshotRow {
  dir: string;
  createdAt: string | null;
  kshetraId: string | null;
  labels: Record<string, string>;
  beadCount: number | null;
  memoryCount: number | null;
  beadIdHash: string | null;
  build: string;
  sizeBytes: number;
  unreadable: boolean;
  reason: string | null;
  // A short marker (S1, S2, …) shared by every row with the same beadIdHash when
  // that hash appears on more than one row; '' otherwise.
  stateMarker: string;
}

// Assign a short marker to each beadIdHash that appears on MORE THAN ONE readable
// row, so equal starting states line up at a glance. A hash unique to one row
// gets no marker (nothing to disambiguate).
function assignStateMarkers(rows: SnapshotRow[]): void {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.beadIdHash) counts.set(r.beadIdHash, (counts.get(r.beadIdHash) ?? 0) + 1);
  }
  const markerByHash = new Map<string, string>();
  let next = 1;
  // Deterministic marker order: first appearance in the (already newest-first) rows.
  for (const r of rows) {
    if (!r.beadIdHash) continue;
    if ((counts.get(r.beadIdHash) ?? 0) < 2) continue;
    if (!markerByHash.has(r.beadIdHash)) markerByHash.set(r.beadIdHash, `S${next++}`);
  }
  for (const r of rows) {
    r.stateMarker = (r.beadIdHash && markerByHash.get(r.beadIdHash)) || '';
  }
}

function buildRow(dir: string, path: string, manifest: SnapshotManifest | null, unreadable: boolean, reason: string | undefined): SnapshotRow {
  if (unreadable || !manifest) {
    return {
      dir,
      createdAt: null,
      kshetraId: null,
      labels: {},
      beadCount: null,
      memoryCount: null,
      beadIdHash: null,
      build: '?',
      // Size on disk is knowable even for an unreadable manifest.
      sizeBytes: pathSizeBytes(path),
      unreadable: true,
      reason: reason ?? 'unreadable',
      stateMarker: '',
    };
  }
  return {
    dir,
    createdAt: manifest.createdAt ?? null,
    kshetraId: manifest.kshetraId ?? null,
    labels: manifest.labels ?? {},
    beadCount: manifest.beads?.beadCount ?? null,
    memoryCount: manifest.beads?.memoryCount ?? null,
    beadIdHash: manifest.beads?.beadIdHash ?? null,
    build: formatBuild(manifest.shreniBuild),
    sizeBytes: pathSizeBytes(path),
    unreadable: false,
    reason: null,
    stateMarker: '',
  };
}

// Render the rows as a fixed-width table. Kept dependency-free (the CLI has no
// table lib); columns pad to their widest cell.
function renderTable(rows: SnapshotRow[]): string {
  const headers = ['STATE', 'CREATED', 'DIRECTORY', 'KSHETRA', 'BEADS', 'MEM', 'HASH', 'BUILD', 'SIZE', 'LABELS'];
  const cells: string[][] = rows.map(r => {
    if (r.unreadable) {
      // A bad row still occupies the grid so counts/columns don't shift; its
      // detail rides in the LABELS column as an explicit reason.
      return [r.stateMarker, '—', r.dir, '—', '—', '—', '—', '—', formatBytes(r.sizeBytes), `UNREADABLE: ${r.reason ?? ''}`];
    }
    return [
      r.stateMarker,
      (r.createdAt ?? '—').replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
      r.dir,
      r.kshetraId ?? '—',
      r.beadCount === null ? '—' : String(r.beadCount),
      r.memoryCount === null ? '—' : String(r.memoryCount),
      shortHash(r.beadIdHash ?? undefined),
      r.build,
      formatBytes(r.sizeBytes),
      formatLabels(r.labels),
    ];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), ...cells.map(line)].join('\n');
}

export function runSnapshotsList(ctx: CommandContext): void {
  // Extract the <parent> positional while skipping flags AND their values, so
  // order doesn't matter: `list <parent> --kshetra x` and `list --kshetra x
  // <parent>` both resolve <parent> correctly (a naive "first non---" scan would
  // grab the --kshetra VALUE as the parent).
  const positionals: string[] = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '--kshetra') {
      i++; // consume its value
      continue;
    }
    if (a.startsWith('--')) continue; // valueless flag (e.g. --json)
    positionals.push(a);
  }
  const parent = positionals[0];
  if (!parent) throw new Error('Usage: shreni snapshots list <parent> [--kshetra <id>] [--json]');
  const filterKshetra = ctx.flag('--kshetra');
  const json = ctx.has('--json');

  const scanned = scanSnapshotParent(parent);
  let rows = scanned.map(e => buildRow(e.dir, e.path, e.manifest, e.unreadable, e.reason));

  // --kshetra keeps only rows we can CONFIRM belong to that kshetra. An unreadable
  // manifest has an unknown kshetraId, so it cannot be confirmed and is dropped
  // under a filter (shown, as an explicit bad row, only in the unfiltered view).
  if (filterKshetra) rows = rows.filter(r => r.kshetraId === filterKshetra);

  // Newest first by manifest createdAt (NOT mtime); unreadable rows (null
  // createdAt) sink to the bottom, ordered by dir name for stability.
  rows.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return a.dir.localeCompare(b.dir);
  });

  assignStateMarkers(rows);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(
      filterKshetra
        ? `No snapshots for kshetra "${filterKshetra}" under ${parent}`
        : `No snapshots found under ${parent}`,
    );
    return;
  }

  console.log(renderTable(rows));
}

// Entry point for the `snapshots` command: only the `list` subcommand exists.
export function runSnapshots(ctx: CommandContext): void {
  const sub = ctx.args[0];
  if (sub !== 'list') {
    throw new Error('Usage: shreni snapshots list <parent> [--kshetra <id>] [--json]');
  }
  // Hand the list handler a context over the args after `list`, so <parent> is
  // the first positional and flag/has scan only the subcommand's own args.
  runSnapshotsList(makeContext(ctx.args.slice(1)));
}
