// `shreni report [@kshetra]` (epic g2k.3). Reads a Kshetra's three durable feeds
// — activity.jsonl, usage.jsonl, notifications.jsonl — feeds them to the pure
// aggregator (computeMetrics, g2k.2), and prints a terminal table. Reading the
// files lives HERE, not in the aggregator, so the metric definitions stay
// side-effect-free and unit-testable against fixtures; this module owns the IO
// and the presentation.

import { readFileSync } from 'fs';
import { loadRegistry } from '../kshetra/registry';
import { resolveTargetKshetra } from './suthradhara';
import { logPath, usagePath } from '../sthapathi/activity-log';
import { readNotifications } from '../sthapathi/notifications';
import { computeMetrics, computeTurnSeries, type Metrics } from '../sthapathi/metrics';
import type { LoggedEvent } from '../sthapathi/activity-log';
import type { UsageEntry } from '../ext/types';
import type { KshetraConfig } from '../kshetra/config';

// Read one JSONL feed into a typed array. Mirrors readNotifications' contract: a
// missing file (ENOENT) yields [], a corrupt line is skipped rather than failing
// the whole read. No validation beyond JSON.parse — the aggregator tolerates
// partial records, and a report should never crash on a half-written feed.
function readJsonl<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      continue; // skip a corrupt line rather than fail the whole read
    }
  }
  return out;
}

// Gather the three feeds for a Kshetra into the aggregator's input shape.
export function readFeeds(kshetraId: string): {
  events: LoggedEvent[];
  usage: UsageEntry[];
  notifications: ReturnType<typeof readNotifications>;
} {
  return {
    events: readJsonl<LoggedEvent>(logPath(kshetraId)),
    usage: readJsonl<UsageEntry>(usagePath(kshetraId)),
    notifications: readNotifications(kshetraId),
  };
}

// ── formatting helpers (deterministic; no locale) ───────────────────────────

// Thousands separator without Intl (keeps output stable across locales/CI).
function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// A fraction in [0,1] → "18.2%".
function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// USD with four decimals — small per-run costs would round to $0.00 at two.
function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// Render the rounds-to-approve distribution as "1×7, 2×3" (rounds×count),
// ordered by round count ascending. Empty string when no approved tasks.
function fmtDistribution(dist: Record<number, number>): string {
  const rounds = Object.keys(dist)
    .map(Number)
    .sort((a, b) => a - b);
  if (rounds.length === 0) return '';
  return rounds.map(r => `${r}×${dist[r]}`).join(', ');
}

// ── renderer (pure: Metrics + id → string) ──────────────────────────────────

const PER_BEAD_COLUMNS: { header: string; get: (b: Metrics['perBead'][number]) => string }[] = [
  { header: 'BEAD', get: b => b.beadId },
  { header: 'RUNS', get: b => fmtInt(b.runs) },
  { header: 'INPUT', get: b => fmtInt(b.inputTokens) },
  { header: 'OUTPUT', get: b => fmtInt(b.outputTokens) },
  { header: 'CACHE-R', get: b => fmtInt(b.cacheReadTokens) },
  { header: 'CACHE-W', get: b => fmtInt(b.cacheCreationTokens) },
  { header: 'TOKENS', get: b => fmtInt(b.totalTokens) },
  { header: 'COST', get: b => fmtCost(b.costUsd) },
];

// Left-align the first column (bead id), right-align the rest (numbers).
function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map(r => (r[c] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c])))
      .join('  ')
      .trimEnd();
  const out = [line(headers)];
  out.push(widths.map(w => '─'.repeat(w)).join('  '));
  for (const row of rows) out.push(line(row));
  return out;
}

export function renderReport(kshetraId: string, m: Metrics): string {
  const lines: string[] = [];
  lines.push(`Run metrics: ${kshetraId}`);
  lines.push('─'.repeat(50));

  // An untouched Kshetra: nothing claimed, no rounds in flight, no usage, no
  // alerts. Say so plainly rather than printing a wall of zeros. `totalRounds`
  // guards the mid-review case — a task with viharapala_done but no task_done yet
  // has totalTasks 0 but a non-zero reject rate/round count that must not be
  // hidden behind "no runs".
  if (
    m.totalTasks === 0 && m.totalRounds === 0 && m.perBead.length === 0 &&
    m.escalations === 0 && m.stuckEvents === 0
  ) {
    lines.push('No runs recorded yet.');
    lines.push('Metrics appear once this Kshetra completes work — check back after a run,');
    lines.push('or `shreni status` to see what it is doing now.');
    return lines.join('\n');
  }

  // Task outcomes + review quality.
  lines.push('');
  lines.push('Tasks');
  lines.push(`  Total tasks         ${fmtInt(m.totalTasks)}`);
  lines.push(`  Approved            ${fmtInt(m.approvedTasks)}`);
  lines.push(
    `  Reject rate         ${fmtPct(m.rejectRate)}  (${fmtInt(m.rejectedRounds)}/${fmtInt(m.totalRounds)} rounds)`,
  );
  const dist = fmtDistribution(m.roundsToApproveDistribution);
  lines.push(
    `  Avg rounds→approve  ${m.avgRoundsToApprove}${dist ? `  (${dist})` : ''}`,
  );
  lines.push(`  Escalations         ${fmtInt(m.escalations)}  (${fmtPct(m.escalationRate)})`);
  lines.push(`  Stuck               ${fmtInt(m.stuckEvents)}  (${fmtPct(m.stuckRate)})`);

  // Tokens & cost.
  lines.push('');
  lines.push('Tokens & cost per bead');
  if (m.perBead.length === 0) {
    lines.push('  (no usage recorded)');
  } else {
    const rows = m.perBead.map(b => PER_BEAD_COLUMNS.map(col => col.get(b)));
    // Totals row mirrors the same columns so it aligns under the table.
    const totalRuns = m.perBead.reduce((s, b) => s + b.runs, 0);
    const totalInput = m.perBead.reduce((s, b) => s + b.inputTokens, 0);
    const totalOutput = m.perBead.reduce((s, b) => s + b.outputTokens, 0);
    const totalCacheR = m.perBead.reduce((s, b) => s + b.cacheReadTokens, 0);
    const totalCacheW = m.perBead.reduce((s, b) => s + b.cacheCreationTokens, 0);
    rows.push([
      'TOTAL',
      fmtInt(totalRuns),
      fmtInt(totalInput),
      fmtInt(totalOutput),
      fmtInt(totalCacheR),
      fmtInt(totalCacheW),
      fmtInt(m.totalTokens),
      fmtCost(m.totalCostUsd),
    ]);
    for (const row of renderTable(PER_BEAD_COLUMNS.map(c => c.header), rows)) {
      lines.push(`  ${row}`);
    }
    if (m.unpricedRuns > 0) {
      lines.push(
        `  cost is a LOWER BOUND: ${fmtInt(m.unpricedRuns)} unpriced run${m.unpricedRuns === 1 ? '' : 's'} (no price-table entry)`,
      );
    }
  }

  return lines.join('\n');
}

// ── command entry ────────────────────────────────────────────────────────────

export interface ReportOpts {
  args: string[];
  flagKshetra: string | undefined;
  cwd: string;
  kshetras?: KshetraConfig[];
  // `--turns`: emit the per-turn context series (epic 408/A1) as JSON instead of
  // the terminal table — the machine-readable input to E1 Figure 1. The default
  // (unset) text report is unchanged.
  turns?: boolean;
}

export function runReport(opts: ReportOpts): void {
  const kshetras = opts.kshetras ?? loadRegistry();
  const kshetra = resolveTargetKshetra(opts.args, opts.flagKshetra, opts.cwd, kshetras);
  const feeds = readFeeds(kshetra.id);
  if (opts.turns) {
    // One JSON object per line (JSONL): streams row-by-row into a plotting/
    // analysis pipeline without loading the whole array, and matches the JSONL
    // shape of the feeds it is derived from.
    for (const row of computeTurnSeries(feeds.events)) console.log(JSON.stringify(row));
    return;
  }
  const metrics = computeMetrics(feeds);
  console.log(renderReport(kshetra.id, metrics));
}
