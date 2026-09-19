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

// Per-run context-usage metrics (epic 408/A1). Keyed by runId. `peakContext` and
// `contextWindow` are `null` — NOT 0 — when the run surfaced no measurement, so a
// reader can tell "no context data" (older data, or codex/gemini which don't emit
// turn_usage) from a genuine zero.
//   • peakContext = max over MAIN-THREAD turn_usage of effective_context
//     (inputTokens + cacheReadTokens + cacheCreationTokens), also max'd with any
//     context_compacted.preTokens in the same run — the true peak sits just before
//     a compaction and the last captured turn can understate it. Sidechain turns
//     are excluded (they live in a different context window).
//   • turns = count of MAIN-THREAD turn_usage. compactions = count of
//     context_compacted. contextWindow = the run's model context window (the
//     denominator peakContext is judged against), from run_usage.
export interface PerRunContext {
  runId: string;
  beadId: string;
  agent: string | null;
  peakContext: number | null;
  turns: number;
  compactions: number;
  contextWindow: number | null;
}

// Per-bead roll-up of the same context metrics. peakContext/contextWindow are the
// max over the bead's runs (null when no run had a measurement); turns and
// compactions are summed.
export interface PerBeadContext {
  beadId: string;
  peakContext: number | null;
  turns: number;
  compactions: number;
  contextWindow: number | null;
}

// One row per model call — the machine-readable input to E1 Figure 1 (epic
// 408/A1). `effectiveContext` is DERIVED here, not stored on the event.
// `compactedAfter` marks the main-thread turn immediately before a compaction
// boundary (context_compacted.turnIndex is that last-before-boundary index).
export interface TurnContextRow {
  runId: string;
  beadId: string;
  agent: string;
  turnIndex: number;
  effectiveContext: number;
  sidechain: boolean;
  compactedAfter: boolean;
}

// ── Per-lot time breakdown (epic hto / Study A3) ─────────────────────────────

// One beads-repo interaction (interactions.jsonl, git-tracked since 4a2.7). Only
// the fields the waiting-on-human derivation needs; tolerant of the rest.
export interface BeadInteraction {
  created_at?: string;
  issue_id?: string;
  kind?: string;
  actor?: string;
}

// Attribution of one agent role's session time within a lot. `durationMs` is the
// sum of the KNOWN run_usage.durationMs (pre-A3 rows lack it); `unknownSessions`
// counts sessions whose duration was not recorded (their time falls into the
// lot's unexplained residual, never silently zeroed).
export interface RoleTimeAttribution {
  agent: string;
  sessions: number;
  durationMs: number;
  unknownSessions: number;
}

// Per-gate attribution (attribution ONLY — never summed into the gates total,
// since parallel gates overlap). `durationMs` sums the known gate_result.durationMs.
export interface GateTimeAttribution {
  gate: string;
  runs: number;
  durationMs: number;
  unknownRuns: number;
}

// Where one lot's Shreni-measured time went. Every *Ms is monotonic process time
// summed from durations recorded at the site; `shreniElapsedMs` is wall-clock
// (worker_started ts → the lot's last event ts). `unexplainedMs` = elapsed minus
// the attributed parts — the instrumentation's own validity check.
export interface LotTimeBreakdown {
  lotId: string;
  entrypoint: string | null;
  shreniElapsedMs: number | null;
  roles: RoleTimeAttribution[];      // agent sessions, by role
  sessionsMs: number;                // sum of known session durations
  gatesMs: number;                   // sum of round-level gatesElapsedMs (not per-gate)
  gates: GateTimeAttribution[];      // per-gate attribution (not summed into total)
  mergeMs: number;
  syncMs: number;
  selectMs: number;
  prepareMs: number;
  idleMs: number;                    // idle (poll) time, minus waiting-on-human
  waitingOnHumanMs: number;
  unexplainedMs: number | null;
  unexplainedPct: number | null;
  // True when any run_usage in the lot lacked durationMs (pre-A3 data): the report
  // shows 'unknown' rather than silently counting it as zero.
  hasUnknownDurations: boolean;
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

  // Context-usage study metrics (epic 408/A1), from the turn_usage /
  // context_compacted / run_usage streams. Empty arrays when nothing recorded.
  perRunContext: PerRunContext[];   // sorted by beadId (numeric) then runId
  perBeadContext: PerBeadContext[]; // sorted by beadId (numeric)

  // Per-lot time breakdown (epic hto / Study A3), one entry per worker_started
  // lot, in first-seen order. Empty when no lot manifest was recorded (pre-B2).
  lots: LotTimeBreakdown[];

  // Ablated work (epic 8wi / Study B1). `beads` are the beadIds excluded from the
  // product-quality metrics above (their spend is still in perBead/totals);
  // `byLabel` counts ablated beads per switch, keyed off the generic marker so a
  // new switch appears with no metrics-code change. Empty when nothing was ablated
  // (the report omits the section, so output is byte-identical to before).
  ablated: { beads: string[]; byLabel: Record<string, number> };
}

// The three parsed feeds. Any may be empty/omitted — a Kshetra that has run
// nothing yields the zeroed snapshot below.
export interface MetricsInput {
  events?: LoggedEvent[];
  usage?: UsageEntry[];
  notifications?: Notification[];
  // Beads-repo interactions (interactions.jsonl), for the waiting-on-human
  // derivation in the per-lot time breakdown (epic hto / Study A3). Optional.
  interactions?: BeadInteraction[];
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

  // --- Ablated beads (epic 8wi / Study B1) ---
  // A bead is ablated if ANY of its events carries a non-empty generic `ablations`
  // marker (review_ablated carries ['review']; a suppressed-blocker gate_result
  // carries ['enforcement']). Keyed off the marker, NOT switch names, so a new
  // switch needs no change here. Ablated beads are EXCLUDED from the product-quality
  // metrics (rejectRate, avgRoundsToApprove, the distribution) so they stay honest,
  // and reported separately per switch; their token/cost spend is still counted
  // (it was real — the usage feed is not filtered).
  const ablatedBeads = new Set<string>();
  const ablatedByLabel: Record<string, number> = {};
  const switchBeads = new Map<string, Set<string>>();
  for (const ev of events) {
    const abls = (ev as { ablations?: unknown }).ablations;
    const beadId = (ev as { beadId?: unknown }).beadId;
    if (typeof beadId !== 'string' || !Array.isArray(abls) || abls.length === 0) continue;
    ablatedBeads.add(beadId);
    for (const s of abls) {
      const label = String(s);
      let set = switchBeads.get(label);
      if (!set) { set = new Set<string>(); switchBeads.set(label, set); }
      set.add(beadId);
    }
  }
  for (const [label, set] of switchBeads) ablatedByLabel[label] = set.size;

  // --- Task outcomes + rounds-to-approve (task_done) ---
  // totalTasks / approvedTasks are raw counts over ALL beads; the AVERAGE and
  // distribution exclude ablated beads (product-quality metric).
  let totalTasks = 0;
  let approvedTasks = 0;
  const roundsToApproveDistribution: Record<number, number> = {};
  let roundsToApproveSum = 0;
  let nonAblatedApproved = 0;
  for (const ev of events) {
    if (ev.type !== 'task_done') continue;
    totalTasks++;
    if (ev.approved) {
      approvedTasks++;
      if (!ablatedBeads.has(ev.beadId)) {
        nonAblatedApproved++;
        roundsToApproveSum += ev.rounds;
        roundsToApproveDistribution[ev.rounds] = (roundsToApproveDistribution[ev.rounds] ?? 0) + 1;
      }
    }
  }
  const avgRoundsToApprove =
    nonAblatedApproved === 0 ? 0 : Math.round((roundsToApproveSum / nonAblatedApproved) * 100) / 100;

  // --- Reject rate over review rounds (viharapala_done), ablated beads excluded ---
  let totalRounds = 0;
  let rejectedRounds = 0;
  for (const ev of events) {
    if (ev.type !== 'viharapala_done') continue;
    if (ablatedBeads.has(ev.beadId)) continue;
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

  // --- Context-usage study metrics (epic 408/A1) ---
  // Group by runId. A run is seeded from ANY of run_usage / turn_usage /
  // context_compacted, so a metered codex/gemini run (run_usage but no turn_usage)
  // still appears — with peakContext null, not 0. peakContext stays null until a
  // MAIN-THREAD turn or a compaction with known preTokens contributes a number.
  const byRun = new Map<string, PerRunContext>();
  const ensureRun = (runId: string, beadId: string, agent: string | null): PerRunContext => {
    let r = byRun.get(runId);
    if (!r) {
      r = { runId, beadId, agent, peakContext: null, turns: 0, compactions: 0, contextWindow: null };
      byRun.set(runId, r);
    }
    if (!r.beadId && beadId) r.beadId = beadId;
    if (r.agent == null && agent != null) r.agent = agent;
    return r;
  };
  for (const ev of events) {
    if (!ev.runId) continue; // ungrouped events (pre-claim) carry no context series
    if (ev.type === 'run_usage') {
      const r = ensureRun(ev.runId, ev.beadId, ev.agent);
      if (ev.contextWindow != null) r.contextWindow = Math.max(r.contextWindow ?? 0, ev.contextWindow);
    } else if (ev.type === 'turn_usage') {
      const r = ensureRun(ev.runId, ev.beadId, ev.agent);
      if (!ev.sidechain) {
        // Main thread only: sidechain calls live in a different context window.
        r.turns++;
        const eff = ev.inputTokens + ev.cacheReadTokens + ev.cacheCreationTokens;
        r.peakContext = Math.max(r.peakContext ?? 0, eff);
      }
    } else if (ev.type === 'context_compacted') {
      const r = ensureRun(ev.runId, ev.beadId, ev.agent);
      r.compactions++;
      // The true peak sits just before the boundary; fold preTokens in so a
      // compaction that exceeds every captured turn is reported as the peak. A 0
      // preTokens (missing compact_metadata) is NOT a measurement — skip it so it
      // never fabricates a peak of 0 on an otherwise-unmeasured run.
      if (ev.preTokens > 0) r.peakContext = Math.max(r.peakContext ?? 0, ev.preTokens);
    }
  }
  const byBeadNumeric = (a: { beadId: string }, b: { beadId: string }): number =>
    a.beadId.localeCompare(b.beadId, 'en', { numeric: true });
  const perRunContext = [...byRun.values()].sort(
    (a, b) => byBeadNumeric(a, b) || a.runId.localeCompare(b.runId),
  );
  const beadCtx = new Map<string, PerBeadContext>();
  for (const r of perRunContext) {
    let b = beadCtx.get(r.beadId);
    if (!b) {
      b = { beadId: r.beadId, peakContext: null, turns: 0, compactions: 0, contextWindow: null };
      beadCtx.set(r.beadId, b);
    }
    b.turns += r.turns;
    b.compactions += r.compactions;
    if (r.peakContext != null) b.peakContext = Math.max(b.peakContext ?? 0, r.peakContext);
    if (r.contextWindow != null) b.contextWindow = Math.max(b.contextWindow ?? 0, r.contextWindow);
  }
  const perBeadContext = [...beadCtx.values()].sort(byBeadNumeric);

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
    perRunContext,
    perBeadContext,
    lots: computeLotBreakdowns(events, notifications, input.interactions ?? []),
    ablated: {
      beads: [...ablatedBeads].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      byLabel: ablatedByLabel,
    },
  };
}

// Total length of a set of [start,end] intervals with overlaps merged — so two
// escalation windows that overlap (or share a resolution) count their union once,
// never twice (epic hto / Study A3).
function mergeIntervalsMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

// Per-lot time breakdown (epic hto / Study A3). PURE over the feeds. For each lot
// (worker_started, keyed by envelope lotId) it computes Shreni elapsed (wall-clock
// span) and the process-time breakdown beneath it from durations recorded at the
// site — never re-measured. `unexplainedMs` = elapsed minus the attributed parts,
// so parts + unexplained == elapsed by construction (the validity check).
export function computeLotBreakdowns(
  events: LoggedEvent[],
  notifications: Notification[],
  interactions: BeadInteraction[],
): LotTimeBreakdown[] {
  // Group events by lotId in first-seen order. A lotId with no worker_started
  // manifest has no start ts and is not a reportable lot.
  const order: string[] = [];
  const byLot = new Map<string, LoggedEvent[]>();
  for (const ev of events) {
    const lotId = (ev as { lotId?: string }).lotId;
    if (!lotId) continue;
    let arr = byLot.get(lotId);
    if (!arr) { arr = []; byLot.set(lotId, arr); order.push(lotId); }
    arr.push(ev);
  }

  const parseTs = (ts: string | undefined): number | null => {
    if (!ts) return null;
    const t = Date.parse(ts);
    return Number.isNaN(t) ? null : t;
  };

  const out: LotTimeBreakdown[] = [];
  for (const lotId of order) {
    const lotEvents = byLot.get(lotId)!;
    const started = lotEvents.find(e => e.type === 'worker_started');
    if (!started) continue;

    const startMs = parseTs(started.ts);
    let lastMs: number | null = null;
    for (const e of lotEvents) {
      const t = parseTs(e.ts);
      if (t !== null && (lastMs === null || t > lastMs)) lastMs = t;
    }
    const shreniElapsedMs =
      startMs !== null && lastMs !== null ? Math.max(0, lastMs - startMs) : null;

    // Agent sessions, by role — sum KNOWN run_usage.durationMs; a session with no
    // duration (pre-A3) is counted but its time falls into unexplained, not zeroed.
    const roleMap = new Map<string, RoleTimeAttribution>();
    let sessionsMs = 0;
    let hasUnknownDurations = false;
    for (const e of lotEvents) {
      if (e.type !== 'run_usage') continue;
      let r = roleMap.get(e.agent);
      if (!r) { r = { agent: e.agent, sessions: 0, durationMs: 0, unknownSessions: 0 }; roleMap.set(e.agent, r); }
      r.sessions++;
      if (typeof e.durationMs === 'number') { r.durationMs += e.durationMs; sessionsMs += e.durationMs; }
      else { r.unknownSessions++; hasUnknownDurations = true; }
    }
    const roles = [...roleMap.values()].sort((a, b) => a.agent.localeCompare(b.agent));

    // Gates: the round-level elapsed (silpi_done.gatesElapsedMs) is the TOTAL —
    // per-gate durations overlap under Promise.all and must never be summed. The
    // per-gate figures are attribution only.
    let gatesMs = 0;
    for (const e of lotEvents) {
      if (e.type === 'silpi_done' && typeof e.gatesElapsedMs === 'number') gatesMs += e.gatesElapsedMs;
    }
    const gateMap = new Map<string, GateTimeAttribution>();
    for (const e of lotEvents) {
      if (e.type !== 'gate_result') continue;
      let g = gateMap.get(e.gate);
      if (!g) { g = { gate: e.gate, runs: 0, durationMs: 0, unknownRuns: 0 }; gateMap.set(e.gate, g); }
      g.runs++;
      if (typeof e.durationMs === 'number') g.durationMs += e.durationMs;
      else g.unknownRuns++;
    }
    const gates = [...gateMap.values()].sort((a, b) => a.gate.localeCompare(b.gate));

    let mergeMs = 0, syncMs = 0;
    for (const e of lotEvents) {
      if (e.type === 'merge_done' && typeof e.durationMs === 'number') mergeMs += e.durationMs;
      else if (e.type === 'beads_synced' && typeof e.durationMs === 'number') syncMs += e.durationMs;
    }

    // Select / prepare / idle from phase_changed heldMs, keyed by the phase LEFT.
    // WORKING heldMs is intentionally NOT a line: that time is decomposed into
    // sessions/gates/merge, and any remainder is the agent overhead in unexplained.
    let selectMs = 0, prepareMs = 0, idleMs = 0;
    for (const e of lotEvents) {
      if (e.type !== 'phase_changed') continue;
      if (e.from === 'SELECTING') selectMs += e.heldMs;
      else if (e.from === 'PREPARING') prepareMs += e.heldMs;
      else if (e.from === 'IDLE') idleMs += e.heldMs;
    }

    // Waiting on human: from each escalation/stuck notification within this lot's
    // span to the next human interaction on that bead (interactions.jsonl), or the
    // lot end if unresolved. Derived — no new capture. Each window is CLIPPED to the
    // lot span (a human resolving after the lot ended can't be waited on within it)
    // and OVERLAPPING windows are merged, so it is counted once — not double-counted
    // across escalations that share one resolution (epic hto decision 6).
    let waitingOnHumanMs = 0;
    if (startMs !== null) {
      const lotEndMs = lastMs ?? startMs;
      const windows: Array<[number, number]> = [];
      for (const n of notifications) {
        if (!n.beadId) continue;
        const isEscalation = (ESCALATION_EVENTS as readonly string[]).includes(n.event) || n.event === STUCK_EVENT;
        if (!isEscalation) continue;
        const notifMs = parseTs(n.ts);
        if (notifMs === null || notifMs < startMs || notifMs > lotEndMs) continue;
        let resolveMs: number | null = null;
        for (const it of interactions) {
          if (it.issue_id !== n.beadId) continue;
          const t = parseTs(it.created_at);
          if (t !== null && t > notifMs && (resolveMs === null || t < resolveMs)) resolveMs = t;
        }
        const endMs = Math.min(resolveMs ?? lotEndMs, lotEndMs);
        if (endMs > notifMs) windows.push([notifMs, endMs]);
      }
      waitingOnHumanMs = mergeIntervalsMs(windows);
    }
    // The wait happened while the worker polled (phase IDLE), so subtract it from
    // idle to attribute it once — to waiting-on-human, not idle (epic hto).
    const idleReported = Math.max(0, idleMs - waitingOnHumanMs);

    const attributed =
      sessionsMs + gatesMs + mergeMs + syncMs + selectMs + prepareMs + idleReported + waitingOnHumanMs;
    const unexplainedMs = shreniElapsedMs !== null ? shreniElapsedMs - attributed : null;
    const unexplainedPct =
      shreniElapsedMs !== null && shreniElapsedMs > 0 && unexplainedMs !== null
        ? Math.round((unexplainedMs / shreniElapsedMs) * 10_000) / 10_000
        : null;

    const entrypointRaw = (started as { entrypoint?: unknown }).entrypoint;
    out.push({
      lotId,
      entrypoint: typeof entrypointRaw === 'string' ? entrypointRaw : null,
      shreniElapsedMs,
      roles, sessionsMs, gatesMs, gates,
      mergeMs, syncMs, selectMs, prepareMs,
      idleMs: idleReported, waitingOnHumanMs,
      unexplainedMs, unexplainedPct, hasUnknownDurations,
    });
  }
  return out;
}

// The per-turn context series (epic 408/A1) — one row per model call, the input
// to E1 Figure 1. PURE over the event stream, kept out of computeMetrics so the
// (potentially large, O(turns)) series is only materialized when explicitly asked
// for (`shreni report --turns`). Rows preserve stream order so the effective-
// context curve plots directly. `effectiveContext` is derived here at read time.
export function computeTurnSeries(events: LoggedEvent[]): TurnContextRow[] {
  // Which main-thread turnIndexes were immediately followed by a compaction, per
  // run: context_compacted.turnIndex is the last main-thread turn before the
  // boundary, so that turn is the one "compacted after".
  const compactedTurns = new Map<string, Set<number>>();
  for (const ev of events) {
    if (ev.type !== 'context_compacted' || !ev.runId) continue;
    let s = compactedTurns.get(ev.runId);
    if (!s) {
      s = new Set<number>();
      compactedTurns.set(ev.runId, s);
    }
    s.add(ev.turnIndex);
  }
  const rows: TurnContextRow[] = [];
  for (const ev of events) {
    if (ev.type !== 'turn_usage' || !ev.runId) continue;
    rows.push({
      runId: ev.runId,
      beadId: ev.beadId,
      agent: ev.agent,
      turnIndex: ev.turnIndex,
      effectiveContext: ev.inputTokens + ev.cacheReadTokens + ev.cacheCreationTokens,
      sidechain: ev.sidechain,
      // Only a main-thread turn can be the last-before-boundary (compaction
      // turnIndex is a main-thread index); a sidechain turn is never compactedAfter.
      compactedAfter: !ev.sidechain && (compactedTurns.get(ev.runId)?.has(ev.turnIndex) ?? false),
    });
  }
  return rows;
}
