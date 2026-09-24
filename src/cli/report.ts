// `shreni report [@kshetra]` (epic g2k.3). Reads a Kshetra's three durable feeds
// — activity.jsonl, usage.jsonl, notifications.jsonl — feeds them to the pure
// aggregator (computeMetrics, g2k.2), and prints a terminal table. Reading the
// files lives HERE, not in the aggregator, so the metric definitions stay
// side-effect-free and unit-testable against fixtures; this module owns the IO
// and the presentation.

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadRegistry } from '../kshetra/registry';
import { resolveTargetKshetra } from './suthradhara';
import { logPath, usagePath } from '../sthapathi/activity-log';
import { readNotifications } from '../sthapathi/notifications';
import { computeMetrics, computeTurnSeries, type Metrics, type BeadInteraction, type LotTimeBreakdown } from '../sthapathi/metrics';
import { ABLATIONS } from '../kshetra/ablation';
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

// Gather the feeds for a Kshetra into the aggregator's input shape. The three
// per-Kshetra feeds live under ~/.shreni/kshetra/<id>/; interactions.jsonl lives
// in the BEADS repo (git-tracked since 4a2.7), so it takes the beads path — the
// waiting-on-human derivation (epic hto) reads it. beads path optional so callers
// with only an id (older tests) still work — interactions default to [].
export function readFeeds(kshetraId: string, beadsPath?: string): {
  events: LoggedEvent[];
  usage: UsageEntry[];
  notifications: ReturnType<typeof readNotifications>;
  interactions: BeadInteraction[];
} {
  return {
    events: readJsonl<LoggedEvent>(logPath(kshetraId)),
    usage: readJsonl<UsageEntry>(usagePath(kshetraId)),
    notifications: readNotifications(kshetraId),
    interactions: beadsPath ? readJsonl<BeadInteraction>(join(beadsPath, 'interactions.jsonl')) : [],
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

// A monotonic duration in ms → a compact, stable, locale-free string:
// "1h 4m", "44m 12s", "2.3s", "180ms". null → "unknown" (pre-A3 data, epic hto) —
// never silently rendered as 0.
export function fmtDuration(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
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
    m.escalations === 0 && m.stuckEvents === 0 && m.drains.length === 0
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

  // Ablated work (epic 8wi / Study B1). Only when there IS ablated data, so a
  // normal report is byte-identical. Its spend is already in the tokens table
  // above; this section flags that these beads are excluded from the quality
  // metrics and lists the count per switch (friendly label from the registry when
  // known, the raw key otherwise — a new switch needs no change here).
  if (m.ablated.beads.length > 0) {
    lines.push('');
    lines.push('Ablated (excluded from reject rate / rounds-to-approve — spend still counted)');
    lines.push(`  Ablated beads       ${fmtInt(m.ablated.beads.length)}  (${m.ablated.beads.join(', ')})`);
    for (const [label, count] of Object.entries(m.ablated.byLabel).sort(([a], [b]) => a.localeCompare(b))) {
      const known = (ABLATIONS as Record<string, { description: string }>)[label];
      lines.push(`  ${label.padEnd(18)}${fmtInt(count)} bead${count === 1 ? '' : 's'}${known ? `  — ${known.description}` : ''}`);
    }
  }

  // Time breakdown per lot (epic hto / Study A3). Added section — the existing
  // report above is unchanged, so old snapshots pass apart from this addition.
  if (m.lots.length > 0) {
    lines.push('');
    lines.push('Time breakdown (per lot)');
    for (const lot of m.lots) lines.push(...renderLotTime(lot));
  }

  // Drain outcomes per lot (epic 7h3 / Study B3). The reason a drain ended is
  // shown explicitly, so a stalled trial can never read as a completed one.
  if (m.drains.length > 0) {
    lines.push('');
    lines.push('Drain outcomes (per lot)');
    for (const d of m.drains) {
      const scope = d.scope ? ` · scope ${d.scope}` : '';
      lines.push(
        `  Lot ${d.lotId.slice(0, 8)} · ${d.reason} (exit ${d.exitCode})${scope} · ` +
          `filed ${d.counts.filed} merged ${d.counts.merged} open ${d.counts.open}`,
      );
      for (const s of d.stalled) lines.push(`    ${s.beadId} — ${s.reason}`);
    }
  }

  return lines.join('\n');
}

// One lot's time breakdown block. Shreni elapsed on top, then where it went, with
// the unexplained residual (and its %) as the instrumentation's validity check.
function renderLotTime(lot: LotTimeBreakdown): string[] {
  const short = lot.lotId.slice(0, 8);
  const lines: string[] = [
    `  Lot ${short}${lot.entrypoint ? ` · ${lot.entrypoint}` : ''} · elapsed ${fmtDuration(lot.shreniElapsedMs)}`,
  ];
  const sessionsDetail = lot.roles.length
    ? lot.roles.map(r => `${r.agent} ${fmtDuration(r.durationMs)} (${r.sessions})${r.unknownSessions ? ` +${r.unknownSessions} unknown` : ''}`).join(', ')
    : '';
  // The headline is the serial slice (summed); the per-role detail is the FULL
  // session time incl. concurrent work (the cost view), so it is labelled as such.
  lines.push(`    agent sessions    ${fmtDuration(lot.sessionsMs)}${sessionsDetail ? `   by role (full): ${sessionsDetail}` : ''}`);
  const gatesDetail = lot.gates.length
    ? lot.gates.map(g => `${g.gate} ${fmtDuration(g.durationMs)} (${g.runs})`).join(', ')
    : '';
  lines.push(`    gates             ${fmtDuration(lot.gatesMs)}${gatesDetail ? `   ${gatesDetail}` : ''}`);
  lines.push(`    merge + sync      ${fmtDuration(lot.mergeMs)} + ${fmtDuration(lot.syncMs)}`);
  lines.push(`    select / prepare  ${fmtDuration(lot.selectMs)} / ${fmtDuration(lot.prepareMs)}`);
  lines.push(`    idle (poll)       ${fmtDuration(lot.idleMs)}`);
  lines.push(`    waiting on human  ${fmtDuration(lot.waitingOnHumanMs)}`);
  // Concurrent with the serial timeline above (Shreni-beads-qqq) — shown for
  // completeness but NOT part of the sum, so it never inflates the residual.
  lines.push(
    `    concurrent        sessions ${fmtDuration(lot.concurrentSessionsMs)} + sync ${fmtDuration(lot.concurrentSyncMs)}   (overlapping; not summed)`,
  );
  const pct = lot.unexplainedPct === null ? '' : `  (${fmtPct(lot.unexplainedPct)})`;
  lines.push(`    unexplained       ${fmtDuration(lot.unexplainedMs)}${pct}`);
  if (lot.hasUnknownDurations) {
    lines.push('    (some durations are pre-A3 unknown and fall into unexplained)');
  }
  return lines;
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
  // `--json`: emit the full computed metrics (incl. the per-lot time breakdown
  // with shreniElapsedMs and every field, epic hto / Study A3) as one JSON object,
  // so the study driver can read Shreni elapsed and compute driver-wall − elapsed.
  json?: boolean;
}

export function runReport(opts: ReportOpts): void {
  const kshetras = opts.kshetras ?? loadRegistry();
  const kshetra = resolveTargetKshetra(opts.args, opts.flagKshetra, opts.cwd, kshetras);
  const feeds = readFeeds(kshetra.id, kshetra.beads.path);
  if (opts.turns) {
    // One JSON object per line (JSONL): streams row-by-row into a plotting/
    // analysis pipeline without loading the whole array, and matches the JSONL
    // shape of the feeds it is derived from.
    for (const row of computeTurnSeries(feeds.events)) console.log(JSON.stringify(row));
    return;
  }
  const metrics = computeMetrics(feeds);
  if (opts.json) {
    // Machine-readable: the whole metrics snapshot, so the driver reads
    // lots[].shreniElapsedMs and every breakdown field without scraping the table.
    console.log(JSON.stringify({ kshetra: kshetra.id, ...metrics }, null, 2));
    return;
  }
  console.log(renderReport(kshetra.id, metrics));
}
