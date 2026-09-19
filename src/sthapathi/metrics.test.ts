import { describe, it, expect } from 'vitest';
import { computeMetrics, computeTurnSeries, ESCALATION_EVENT, STUCK_EVENT } from './metrics.js';
import type { LoggedEvent } from './activity-log.js';
import type { Notification } from './notifications.js';
import type { UsageEntry } from '../ext/types.js';
import { USAGE_SCHEMA_VERSION } from '../ext/types.js';

// --- fixture builders ---
const K = 'myapp';
function ev(e: Omit<LoggedEvent, 'ts' | 'schemaVersion'>): LoggedEvent {
  return { ...e, ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1 } as LoggedEvent;
}
function taskDone(beadId: string, approved: boolean, rounds: number): LoggedEvent {
  return ev({ type: 'task_done', kshetra: K, beadId, title: beadId, approved, rounds });
}
function review(beadId: string, verdict: 'APPROVE' | 'REJECT', round: number): LoggedEvent {
  return ev({ type: 'viharapala_done', kshetra: K, beadId, round, verdict, score: verdict === 'APPROVE' ? 90 : 40, mustFix: [] });
}
function usage(beadId: string, over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    kshetra: K, beadId, runId: 'r', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0, outcome: 'ok',
    ts: '2026-09-15T00:00:00.000Z', schemaVersion: USAGE_SCHEMA_VERSION, costUsd: 0, priced: true, ...over,
  };
}
function notif(event: string): Notification {
  return { ts: '2026-09-15T00:00:00.000Z', event, message: event };
}
// --- epic 408/A1 context-metric fixtures ---
function turn(beadId: string, runId: string, turnIndex: number, effective: number, over: { sidechain?: boolean; agent?: 'silpi' | 'viharapala' | 'parikshaka' } = {}): LoggedEvent {
  return { type: 'turn_usage', kshetra: K, beadId, agent: over.agent ?? 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6', turnIndex, messageId: `${runId}-${turnIndex}`, inputTokens: effective, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: over.sidechain ?? false, ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1, runId } as LoggedEvent;
}
function compacted(beadId: string, runId: string, turnIndex: number, preTokens: number): LoggedEvent {
  return { type: 'context_compacted', kshetra: K, beadId, agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6', trigger: 'auto', preTokens, turnIndex, ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1, runId } as LoggedEvent;
}
function runUsage(beadId: string, runId: string, over: { contextWindow?: number; agent?: 'silpi' | 'viharapala' | 'parikshaka' } = {}): LoggedEvent {
  return { type: 'run_usage', kshetra: K, beadId, agent: over.agent ?? 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, outcome: 'ok', ...(over.contextWindow != null ? { contextWindow: over.contextWindow } : {}), ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1, runId } as LoggedEvent;
}

describe('computeMetrics — context-usage study metrics (epic 408/A1)', () => {
  it('computes peak_context, turns and compactions per run and rolls them up per bead', () => {
    const m = computeMetrics({
      events: [
        turn('b1', 'run-1', 0, 1000),
        turn('b1', 'run-1', 1, 5000),
        turn('b1', 'run-1', 2, 3000),
        runUsage('b1', 'run-1', { contextWindow: 200000 }),
      ],
    });
    expect(m.perRunContext).toEqual([
      { runId: 'run-1', beadId: 'b1', agent: 'silpi', peakContext: 5000, turns: 3, compactions: 0, contextWindow: 200000 },
    ]);
    expect(m.perBeadContext).toEqual([
      { beadId: 'b1', peakContext: 5000, turns: 3, compactions: 0, contextWindow: 200000 },
    ]);
  });

  it('excludes sidechain turns from peak_context and the turn count', () => {
    const m = computeMetrics({
      events: [
        turn('b1', 'run-1', 0, 1000),
        turn('b1', 'run-1', 0, 999999, { sidechain: true }), // subagent — different window, excluded
        turn('b1', 'run-1', 1, 2000),
      ],
    });
    expect(m.perRunContext[0]).toMatchObject({ peakContext: 2000, turns: 2 });
  });

  it('reports preTokens as the peak when a compaction exceeds every captured turn', () => {
    const m = computeMetrics({
      events: [
        turn('b1', 'run-1', 0, 5000),
        turn('b1', 'run-1', 1, 8000),
        compacted('b1', 'run-1', 1, 190000), // the true peak sits just before the boundary
      ],
    });
    expect(m.perRunContext[0]).toMatchObject({ peakContext: 190000, turns: 2, compactions: 1 });
  });

  it('reports nulls (not zeros) for a metered run that surfaced no turn_usage (codex/gemini/older data)', () => {
    const m = computeMetrics({ events: [runUsage('b1', 'run-1', { contextWindow: undefined })] });
    expect(m.perRunContext).toEqual([
      { runId: 'run-1', beadId: 'b1', agent: 'silpi', peakContext: null, turns: 0, compactions: 0, contextWindow: null },
    ]);
    expect(m.perBeadContext[0]).toMatchObject({ peakContext: null, turns: 0 });
  });

  it('rolls peak_context and window up as the max, turns/compactions as the sum, across a bead\'s runs', () => {
    const m = computeMetrics({
      events: [
        turn('b1', 'run-1', 0, 3000), compacted('b1', 'run-1', 0, 50000),
        turn('b1', 'run-2', 0, 9000),
        runUsage('b1', 'run-1', { contextWindow: 200000 }),
        runUsage('b1', 'run-2', { contextWindow: 1000000 }),
      ],
    });
    expect(m.perBeadContext).toEqual([
      { beadId: 'b1', peakContext: 50000, turns: 2, compactions: 1, contextWindow: 1000000 },
    ]);
  });
});

describe('computeTurnSeries (epic 408/A1 — E1 Figure 1 input)', () => {
  it('emits one row per turn (main + sidechain) with effectiveContext derived at read time', () => {
    const rows = computeTurnSeries([
      turn('b1', 'run-1', 0, 1000),
      turn('b1', 'run-1', 0, 300, { sidechain: true }),
      turn('b1', 'run-1', 1, 2000),
    ]);
    expect(rows).toEqual([
      { runId: 'run-1', beadId: 'b1', agent: 'silpi', turnIndex: 0, effectiveContext: 1000, sidechain: false, compactedAfter: false },
      { runId: 'run-1', beadId: 'b1', agent: 'silpi', turnIndex: 0, effectiveContext: 300, sidechain: true, compactedAfter: false },
      { runId: 'run-1', beadId: 'b1', agent: 'silpi', turnIndex: 1, effectiveContext: 2000, sidechain: false, compactedAfter: false },
    ]);
  });

  it('sums the three input-side lanes into effectiveContext', () => {
    const t = { ...turn('b1', 'run-1', 0, 0) } as Extract<LoggedEvent, { type: 'turn_usage' }>;
    t.inputTokens = 1000; t.cacheReadTokens = 40000; t.cacheCreationTokens = 200;
    expect(computeTurnSeries([t])[0].effectiveContext).toBe(41200);
  });

  it('marks the main-thread turn immediately before a compaction as compactedAfter', () => {
    const rows = computeTurnSeries([
      turn('b1', 'run-1', 0, 1000),
      turn('b1', 'run-1', 1, 2000),
      compacted('b1', 'run-1', 1, 190000),
      turn('b1', 'run-1', 2, 500),
    ]);
    expect(rows.map(r => r.compactedAfter)).toEqual([false, true, false]);
  });
});

describe('computeMetrics — empty log', () => {
  it('yields a zeroed snapshot, no NaN, for no input at all', () => {
    const m = computeMetrics();
    expect(m).toEqual({
      totalTasks: 0, approvedTasks: 0,
      totalRounds: 0, rejectedRounds: 0, rejectRate: 0,
      avgRoundsToApprove: 0, roundsToApproveDistribution: {},
      escalations: 0, escalationRate: 0, stuckEvents: 0, stuckRate: 0,
      perBead: [], totalTokens: 0, totalCostUsd: 0, unpricedRuns: 0,
      perRunContext: [], perBeadContext: [],
      lots: [],
      ablated: { beads: [], byLabel: {} },
    });
  });

  it('tolerates unknown/new event types (e.g. Suthradhara lifecycle, fnd.1) without throwing or miscounting', () => {
    const m = computeMetrics({
      events: [
        ev({ type: 'suthradhara_launched', kshetra: 'k', sessionId: 's', claudeSessionId: 'c', resume: false }),
        ev({ type: 'suthradhara_menu_choice', kshetra: 'k', sessionId: 's', choice: 'end' }),
        taskDone('b1', true, 2),
      ],
    });
    // The new types are ignored; only the task_done is counted.
    expect(m.totalTasks).toBe(1);
    expect(m.approvedTasks).toBe(1);
  });

  it('treats empty arrays the same as omitted feeds', () => {
    expect(computeMetrics({ events: [], usage: [], notifications: [] })).toEqual(computeMetrics());
  });
});

describe('computeMetrics — reject rate', () => {
  it('is non-APPROVE rounds / total review rounds', () => {
    const m = computeMetrics({
      events: [
        review('b1', 'REJECT', 1), review('b1', 'REJECT', 2), review('b1', 'APPROVE', 3),
        review('b2', 'APPROVE', 1),
      ],
    });
    expect(m.totalRounds).toBe(4);
    expect(m.rejectedRounds).toBe(2);
    expect(m.rejectRate).toBe(0.5);
  });

  it('is 0 (not NaN) when there are no rounds', () => {
    expect(computeMetrics({ events: [taskDone('b1', true, 1)] }).rejectRate).toBe(0);
  });
});

describe('computeMetrics — rounds-to-approve', () => {
  it('averages rounds over APPROVED tasks only and builds a distribution', () => {
    const m = computeMetrics({
      events: [
        taskDone('b1', true, 1),
        taskDone('b2', true, 3),
        taskDone('b3', true, 3),
        taskDone('b4', false, 3), // unapproved: excluded from avg + distribution
      ],
    });
    expect(m.totalTasks).toBe(4);
    expect(m.approvedTasks).toBe(3);
    expect(m.avgRoundsToApprove).toBe(2.33); // (1+3+3)/3, 2dp
    expect(m.roundsToApproveDistribution).toEqual({ 1: 1, 3: 2 });
  });
});

describe('computeMetrics — escalation + stuck', () => {
  it('counts the pinned notification events and rates them over total tasks', () => {
    const m = computeMetrics({
      events: [taskDone('b1', true, 1), taskDone('b2', false, 3), taskDone('b3', true, 2), taskDone('b4', true, 1)],
      notifications: [
        notif(ESCALATION_EVENT), notif(STUCK_EVENT), notif('pr_followup_approved'), notif('merge_conflict'),
      ],
    });
    expect(m.escalations).toBe(1);
    expect(m.stuckEvents).toBe(1);
    expect(m.escalationRate).toBe(0.25); // 1 / 4 tasks
    expect(m.stuckRate).toBe(0.25);
  });

  it('rates are 0 when there are no tasks even if alerts exist', () => {
    const m = computeMetrics({ notifications: [notif(ESCALATION_EVENT), notif(STUCK_EVENT)] });
    expect(m.escalations).toBe(1);
    expect(m.escalationRate).toBe(0);
    expect(m.stuckRate).toBe(0);
  });

  it('folds pr_followup_exhausted into escalations (both hand a run to a human) (8xp)', () => {
    const m = computeMetrics({
      events: [taskDone('b1', true, 1), taskDone('b2', true, 1)],
      notifications: [notif('pr_followup_escalated'), notif('pr_followup_exhausted')],
    });
    expect(m.escalations).toBe(2);
    expect(m.escalationRate).toBe(1); // 2 / 2 tasks
  });
});

describe('computeMetrics — tokens & cost per bead', () => {
  it('sums lanes, tokens and cost per bead, sorted by beadId', () => {
    const m = computeMetrics({
      usage: [
        usage('b2', { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 }),
        usage('b1', { inputTokens: 200, cacheReadTokens: 300, costUsd: 0.002 }),
        usage('b1', { outputTokens: 100, costUsd: 0.003 }),
      ],
    });
    expect(m.perBead.map(b => b.beadId)).toEqual(['b1', 'b2']); // sorted
    const b1 = m.perBead[0];
    expect(b1.inputTokens).toBe(200);
    expect(b1.outputTokens).toBe(100);
    expect(b1.cacheReadTokens).toBe(300);
    expect(b1.totalTokens).toBe(600);
    expect(b1.costUsd).toBeCloseTo(0.005, 6);
    expect(b1.runs).toBe(2);
    expect(m.totalTokens).toBe(600 + 1500);
    expect(m.totalCostUsd).toBeCloseTo(0.015, 6);
  });

  it('flags unpriced runs so the cost reads as a lower bound', () => {
    const m = computeMetrics({
      usage: [
        usage('b1', { provider: 'gemini', model: 'g', priced: false, costUsd: 0 }),
        usage('b1', { inputTokens: 1_000_000, costUsd: 3, priced: true }),
      ],
    });
    expect(m.perBead[0].unpricedRuns).toBe(1);
    expect(m.perBead[0].runs).toBe(2);
    expect(m.unpricedRuns).toBe(1);
    expect(m.totalCostUsd).toBe(3);
  });

  it('orders perBead naturally, not lexicographically (8xp)', () => {
    const m = computeMetrics({
      usage: [
        usage('myapp-10', { costUsd: 0.01 }),
        usage('myapp-2', { costUsd: 0.02 }),
        usage('myapp-1', { costUsd: 0.03 }),
      ],
    });
    // Lexicographic would give myapp-1, myapp-10, myapp-2; natural gives 1, 2, 10.
    expect(m.perBead.map(b => b.beadId)).toEqual(['myapp-1', 'myapp-2', 'myapp-10']);
  });
});

// ── per-lot time breakdown (epic hto / Study A3) ──────────────────────────────

describe('computeLotBreakdowns (epic hto / Study A3)', () => {
  const LOT = 'lot-aaaa1111';
  // A lot-scoped event with an explicit ts (for the elapsed span) and lotId envelope.
  function le(type: string, ts: string, over: Record<string, unknown> = {}): LoggedEvent {
    return { type, kshetra: K, lotId: LOT, ts, schemaVersion: 1, ...over } as LoggedEvent;
  }

  it('breaks a lot into parts whose sum plus unexplained equals Shreni elapsed exactly', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      le('run_usage', '2026-09-15T00:01:00.000Z', { beadId: 'b1', agent: 'silpi', provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, outcome: 'ok', durationMs: 120000 }),
      le('silpi_done', '2026-09-15T00:02:00.000Z', { beadId: 'b1', round: 1, summary: '', confidence: 1, files: [], lintPassed: true, testsPassed: true, gatesElapsedMs: 50000 }),
      le('gate_result', '2026-09-15T00:02:00.000Z', { beadId: 'b1', round: 1, gate: 'test', verdict: 'pass', durationMs: 44000 }),
      le('gate_result', '2026-09-15T00:02:00.000Z', { beadId: 'b1', round: 1, gate: 'coverage', verdict: 'pass', durationMs: 30000 }),
      le('merge_done', '2026-09-15T00:03:00.000Z', { beadId: 'b1', mergePolicy: 'push', durationMs: 8000 }),
      le('beads_synced', '2026-09-15T00:03:10.000Z', { durationMs: 2000 }),
      le('phase_changed', '2026-09-15T00:03:20.000Z', { from: 'SELECTING', to: 'PREPARING', heldMs: 1000 }),
      le('phase_changed', '2026-09-15T00:03:21.000Z', { from: 'PREPARING', to: 'WORKING', heldMs: 3000 }),
      le('phase_changed', '2026-09-15T00:03:22.000Z', { from: 'IDLE', to: 'SELECTING', heldMs: 10000 }),
      le('task_done', '2026-09-15T00:05:00.000Z', { beadId: 'b1', title: 'b1', approved: true, rounds: 1 }),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.shreniElapsedMs).toBe(300000); // 00:00:00 → 00:05:00
    expect(lot.sessionsMs).toBe(120000);
    expect(lot.gatesMs).toBe(50000);
    expect(lot.mergeMs).toBe(8000);
    expect(lot.syncMs).toBe(2000);
    expect(lot.selectMs).toBe(1000);
    expect(lot.prepareMs).toBe(3000);
    expect(lot.idleMs).toBe(10000);
    expect(lot.waitingOnHumanMs).toBe(0);
    expect(lot.unexplainedMs).toBe(106000); // 300000 − (120000+50000+8000+2000+1000+3000+10000)
    // Identity: every part plus unexplained equals elapsed, exactly.
    const sum = lot.sessionsMs + lot.gatesMs + lot.mergeMs + lot.syncMs + lot.selectMs +
      lot.prepareMs + lot.idleMs + lot.waitingOnHumanMs + (lot.unexplainedMs ?? 0);
    expect(sum).toBe(lot.shreniElapsedMs);
  });

  it('does not double-count parallel gates — the round total is not the per-gate sum', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      le('silpi_done', '2026-09-15T00:01:00.000Z', { beadId: 'b1', round: 1, summary: '', confidence: 1, files: [], lintPassed: true, testsPassed: true, gatesElapsedMs: 50000 }),
      le('gate_result', '2026-09-15T00:01:00.000Z', { beadId: 'b1', round: 1, gate: 'coverage', verdict: 'pass', durationMs: 40000 }),
      le('gate_result', '2026-09-15T00:01:00.000Z', { beadId: 'b1', round: 1, gate: 'diffSize', verdict: 'pass', durationMs: 40000 }),
    ];
    const [lot] = computeMetrics({ events }).lots;
    // Round total is the measured block elapsed, strictly less than the per-gate sum.
    expect(lot.gatesMs).toBe(50000);
    const perGateSum = lot.gates.reduce((s, g) => s + g.durationMs, 0);
    expect(perGateSum).toBe(80000);
    expect(lot.gatesMs).toBeLessThan(perGateSum);
  });

  it('attributes an escalation wait to waiting-on-human, not idle, ending at the human interaction', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      // 2h of idle polling accrued while the worker was paused, awaiting a human.
      le('phase_changed', '2026-09-15T02:10:00.000Z', { from: 'IDLE', to: 'SELECTING', heldMs: 7200000, polls: 240 }),
      le('task_done', '2026-09-15T02:10:00.000Z', { beadId: 'b1', title: 'b1', approved: true, rounds: 1 }),
    ];
    const notifications: Notification[] = [
      { ts: '2026-09-15T00:10:00.000Z', event: ESCALATION_EVENT, beadId: 'b1', message: 'escalated' },
    ];
    // The human acted 2h after the escalation.
    const interactions = [{ issue_id: 'b1', created_at: '2026-09-15T02:10:00.000Z', kind: 'field_change', actor: 'human' }];
    const [lot] = computeMetrics({ events, notifications, interactions }).lots;
    expect(lot.waitingOnHumanMs).toBe(7200000); // 2h attributed to waiting…
    expect(lot.idleMs).toBe(0);                  // …and subtracted from idle, not double-counted
  });

  it('shows missing durations as unknown and folds their time into unexplained, never zero', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      // run_usage WITHOUT durationMs (pre-A3 data).
      le('run_usage', '2026-09-15T00:01:00.000Z', { beadId: 'b1', agent: 'silpi', provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, outcome: 'ok' }),
      le('task_done', '2026-09-15T00:05:00.000Z', { beadId: 'b1', title: 'b1', approved: true, rounds: 1 }),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.hasUnknownDurations).toBe(true);
    expect(lot.sessionsMs).toBe(0); // not summed as a real 0…
    expect(lot.roles[0]).toMatchObject({ agent: 'silpi', sessions: 1, unknownSessions: 1 });
    // …the unrecorded session time lands in unexplained (≈ the full elapsed).
    expect(lot.unexplainedMs).toBe(300000);
  });

  it('reports no lots for pre-B2 events that carry no lotId', () => {
    const m = computeMetrics({ events: [taskDone('b1', true, 1)] }); // no lotId
    expect(m.lots).toEqual([]);
  });

  it('merges overlapping escalation windows so a shared resolution is counted once', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      le('task_done', '2026-09-15T03:00:00.000Z', { beadId: 'b1', title: 'b1', approved: true, rounds: 1 }),
    ];
    // Two escalations on the same bead 30m apart, both resolved by ONE interaction
    // at 02:00. Windows [00:30,02:00] and [01:00,02:00] overlap → union is 90m, not 150m.
    const notifications: Notification[] = [
      { ts: '2026-09-15T00:30:00.000Z', event: ESCALATION_EVENT, beadId: 'b1', message: 'e1' },
      { ts: '2026-09-15T01:00:00.000Z', event: STUCK_EVENT, beadId: 'b1', message: 'e2' },
    ];
    const interactions = [{ issue_id: 'b1', created_at: '2026-09-15T02:00:00.000Z', kind: 'field_change', actor: 'human' }];
    const [lot] = computeMetrics({ events, notifications, interactions }).lots;
    expect(lot.waitingOnHumanMs).toBe(90 * 60 * 1000); // union of the two windows, not the sum
  });

  it('clips a waiting window to the lot end when the human resolves after the lot', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      le('task_done', '2026-09-15T01:00:00.000Z', { beadId: 'b1', title: 'b1', approved: true, rounds: 1 }),
    ];
    const notifications: Notification[] = [
      { ts: '2026-09-15T00:30:00.000Z', event: ESCALATION_EVENT, beadId: 'b1', message: 'e1' },
    ];
    // Human resolved at 05:00 — long after the lot ended at 01:00.
    const interactions = [{ issue_id: 'b1', created_at: '2026-09-15T05:00:00.000Z', kind: 'field_change', actor: 'human' }];
    const [lot] = computeMetrics({ events, notifications, interactions }).lots;
    expect(lot.waitingOnHumanMs).toBe(30 * 60 * 1000); // 00:30 → 01:00 (lot end), not → 05:00
  });
});

// ── ablation exclusion + reporting (epic 8wi / Study B1) ──────────────────────

describe('computeMetrics — ablation exclusion (epic 8wi / Study B1)', () => {
  it('excludes review-ablated beads from quality metrics, lists them per switch, keeps spend', () => {
    const m = computeMetrics({
      events: [
        // normal bead: rejected once then approved in 2 rounds
        review('b1', 'REJECT', 1), review('b1', 'APPROVE', 2), taskDone('b1', true, 2),
        // review-ablated bead: merged without review
        ev({ type: 'review_ablated', kshetra: K, beadId: 'b2', round: 1, ablations: ['review'] }),
        taskDone('b2', true, 1),
      ],
      usage: [usage('b2', { inputTokens: 100, costUsd: 0.5 })],
    });
    // Quality metrics over the NORMAL bead only.
    expect(m.rejectRate).toBe(0.5);                       // 1/2 rounds (b1); b2 has no review
    expect(m.avgRoundsToApprove).toBe(2);                // b1's 2 rounds; b2 excluded
    expect(m.roundsToApproveDistribution).toEqual({ 2: 1 });
    // Ablated listing.
    expect(m.ablated.beads).toEqual(['b2']);
    expect(m.ablated.byLabel).toEqual({ review: 1 });
    // Raw counts + spend still include the ablated bead.
    expect(m.totalTasks).toBe(2);
    expect(m.approvedTasks).toBe(2);
    expect(m.totalTokens).toBe(100);
    expect(m.totalCostUsd).toBe(0.5);
    expect(m.perBead.map(b => b.beadId)).toContain('b2');
  });

  it('excludes an enforcement-ablated bead\'s review rounds from reject rate', () => {
    const m = computeMetrics({
      events: [
        review('b1', 'REJECT', 1), review('b1', 'APPROVE', 2), taskDone('b1', true, 2), // normal
        // enforcement-ablated: a warn+ablated gate_result AND a real viharapala_done
        ev({ type: 'gate_result', kshetra: K, beadId: 'b2', round: 1, gate: 'test', verdict: 'warn', ablations: ['enforcement'] }),
        review('b2', 'APPROVE', 1), taskDone('b2', true, 1),
      ],
    });
    expect(m.totalRounds).toBe(2);          // b1 only; b2's review round excluded
    expect(m.rejectRate).toBe(0.5);
    expect(m.avgRoundsToApprove).toBe(2);   // b1 only
    expect(m.ablated.beads).toEqual(['b2']);
    expect(m.ablated.byLabel).toEqual({ enforcement: 1 });
  });

  it('excludes and labels a hypothetical new switch generically (no metrics code change)', () => {
    const m = computeMetrics({
      events: [
        taskDone('b1', true, 1), // normal
        { type: 'gate_result', kshetra: K, beadId: 'bx', round: 1, gate: 'test', verdict: 'warn', ablations: ['newswitch'], ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1 } as unknown as LoggedEvent,
        taskDone('bx', true, 1),
      ],
    });
    expect(m.ablated.beads).toEqual(['bx']);
    expect(m.ablated.byLabel).toEqual({ newswitch: 1 });
    expect(m.avgRoundsToApprove).toBe(1); // b1 only (bx excluded)
  });

  it('reports no ablated data for a normal run', () => {
    const m = computeMetrics({ events: [taskDone('b1', true, 1)] });
    expect(m.ablated).toEqual({ beads: [], byLabel: {} });
  });
});
