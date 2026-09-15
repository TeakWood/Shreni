// Run-metrics aggregator (epic g2k.2). PURE and side-effect-free: it takes the
// already-parsed contents of a Kshetra's three durable feeds and returns a
// Metrics snapshot. Reading the files is the caller's job (the `shreni report`
// CLI, g2k.3) — keeping IO out means the metric definitions can be unit-tested
// against fixture arrays, empty-log included.
//
// The three feeds and what each contributes:
//   • activity.jsonl (LoggedEvent) — task_done.{approved,rounds} for
//     rounds-to-approve, viharapala_done.verdict for reject rate.
//   • usage.jsonl (UsageEntry) — per-bead tokens & cost (g2k.1).
//   • notifications.jsonl (Notification) — escalation (event
//     'pr_followup_escalated') and stuck (event 'stuck') signals. These never
//     reach the activity stream (they are operator alerts written by
//     notifyOperator), so the aggregator reads them here to pin the escalation
//     and stuck definitions the acceptance criteria call for.

import type { LoggedEvent } from './activity-log.js';
import type { Notification } from './notifications.js';
import type { UsageEntry } from '../ext/types.js';

// The notification `event` strings the aggregator keys off. Kept as constants so
// the coupling to the producers (pr-followup-run.ts, watchdog.ts) is explicit
// and greppable rather than a bare string literal buried in a filter.
// Both a PR follow-up that escalates and one that exhausts its rounds are handed
// to a human (pr-followup-run.ts notifies for both, ARD §4.2), so the escalation
// metric counts both — escalationRate measures "runs that needed a human", not
// just the escalated subset.
export const ESCALATION_EVENTS = ['pr_followup_escalated', 'pr_followup_exhausted'] as const;
// Kept for back-compat with existing importers (the primary escalation event).
export const ESCALATION_EVENT = ESCALATION_EVENTS[0];
export const STUCK_EVENT = 'stuck';

// Per-bead token and cost roll-up. `totalTokens` sums the four lanes;
// `unpricedRuns` counts runs whose model had no price entry (costUsd is a 0
// placeholder there, so `costUsd` is a LOWER BOUND when unpricedRuns > 0).
export interface PerBeadUsage {
  beadId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  runs: number;
  unpricedRuns: number;
}

// The full metrics snapshot. Rates are fractions in [0,1]; a rate whose
// denominator is 0 (no rounds / no tasks) is defined as 0, never NaN. Raw counts
// sit beside every rate so the report (g2k.3) can render either without
// recomputing.
export interface Metrics {
  // Task outcomes (task_done events).
  totalTasks: number;
  approvedTasks: number;

  // Reject rate over review rounds (viharapala_done events).
  totalRounds: number;
  rejectedRounds: number;
  rejectRate: number; // rejectedRounds / totalRounds

  // Rounds-to-approve, over APPROVED tasks only.
  avgRoundsToApprove: number; // mean task_done.rounds where approved
  roundsToApproveDistribution: Record<number, number>; // rounds -> approved-task count

  // Escalation + stuck, from the notification feed.
  escalations: number;
  escalationRate: number; // escalations / totalTasks
  stuckEvents: number;
  stuckRate: number; // stuckEvents / totalTasks

  // Tokens & cost (usage feed).
  perBead: PerBeadUsage[]; // sorted by beadId (deterministic output)
  totalTokens: number;
  totalCostUsd: number;
  unpricedRuns: number; // across all beads
}

// The three parsed feeds. Any may be empty/omitted — a Kshetra that has run
// nothing yields the zeroed snapshot below.
export interface MetricsInput {
  events?: LoggedEvent[];
  usage?: UsageEntry[];
  notifications?: Notification[];
}

// A rate whose denominator may be 0: define x/0 as 0 (no data → no rate), and
// round to 4 dp so the report renders a clean percentage.
function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

// Micro-dollar rounding, matching pricing.ts — keeps summed costs free of float
// drift.
function roundCost(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function computeMetrics(input: MetricsInput = {}): Metrics {
  const events = input.events ?? [];
  const usage = input.usage ?? [];
  const notifications = input.notifications ?? [];

  // --- Task outcomes + rounds-to-approve (task_done) ---
  let totalTasks = 0;
  let approvedTasks = 0;
  const roundsToApproveDistribution: Record<number, number> = {};
  let roundsToApproveSum = 0;
  for (const ev of events) {
    if (ev.type !== 'task_done') continue;
    totalTasks++;
    if (ev.approved) {
      approvedTasks++;
      roundsToApproveSum += ev.rounds;
      roundsToApproveDistribution[ev.rounds] = (roundsToApproveDistribution[ev.rounds] ?? 0) + 1;
    }
  }
  const avgRoundsToApprove =
    approvedTasks === 0 ? 0 : Math.round((roundsToApproveSum / approvedTasks) * 100) / 100;

  // --- Reject rate over review rounds (viharapala_done) ---
  let totalRounds = 0;
  let rejectedRounds = 0;
  for (const ev of events) {
    if (ev.type !== 'viharapala_done') continue;
    totalRounds++;
    if (ev.verdict !== 'APPROVE') rejectedRounds++;
  }

  // --- Escalation + stuck (notifications) ---
  let escalations = 0;
  let stuckEvents = 0;
  for (const n of notifications) {
    if ((ESCALATION_EVENTS as readonly string[]).includes(n.event)) escalations++;
    else if (n.event === STUCK_EVENT) stuckEvents++;
  }

  // --- Tokens & cost per bead (usage) ---
  const byBead = new Map<string, PerBeadUsage>();
  for (const u of usage) {
    let agg = byBead.get(u.beadId);
    if (!agg) {
      agg = {
        beadId: u.beadId,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        totalTokens: 0, costUsd: 0, runs: 0, unpricedRuns: 0,
      };
      byBead.set(u.beadId, agg);
    }
    agg.inputTokens += u.inputTokens;
    agg.outputTokens += u.outputTokens;
    agg.cacheReadTokens += u.cacheReadTokens;
    agg.cacheCreationTokens += u.cacheCreationTokens;
    agg.totalTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    agg.costUsd += u.costUsd;
    agg.runs++;
    if (!u.priced) agg.unpricedRuns++;
  }

  const perBead = [...byBead.values()]
    .map(b => ({ ...b, costUsd: roundCost(b.costUsd) }))
    // Natural/numeric order so myapp-2 sorts before myapp-10 (not lexicographic,
    // which would put myapp-10 first). Deterministic across runs.
    .sort((a, b) => a.beadId.localeCompare(b.beadId, 'en', { numeric: true }));

  const totalTokens = perBead.reduce((s, b) => s + b.totalTokens, 0);
  const totalCostUsd = roundCost(perBead.reduce((s, b) => s + b.costUsd, 0));
  const unpricedRuns = perBead.reduce((s, b) => s + b.unpricedRuns, 0);

  return {
    totalTasks,
    approvedTasks,
    totalRounds,
    rejectedRounds,
    rejectRate: rate(rejectedRounds, totalRounds),
    avgRoundsToApprove,
    roundsToApproveDistribution,
    escalations,
    escalationRate: rate(escalations, totalTasks),
    stuckEvents,
    stuckRate: rate(stuckEvents, totalTasks),
    perBead,
    totalTokens,
    totalCostUsd,
    unpricedRuns,
  };
}
