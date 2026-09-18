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
