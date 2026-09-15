import { describe, it, expect } from 'vitest';
import { computeMetrics, ESCALATION_EVENT, STUCK_EVENT } from './metrics.js';
import type { LoggedEvent } from './activity-log.js';
import type { Notification } from './notifications.js';
import type { UsageEntry } from '../ext/types.js';

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
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0,
    ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1, costUsd: 0, priced: true, ...over,
  };
}
function notif(event: string): Notification {
  return { ts: '2026-09-15T00:00:00.000Z', event, message: event };
}

describe('computeMetrics — empty log', () => {
  it('yields a zeroed snapshot, no NaN, for no input at all', () => {
    const m = computeMetrics();
    expect(m).toEqual({
      totalTasks: 0, approvedTasks: 0,
      totalRounds: 0, rejectedRounds: 0, rejectRate: 0,
      avgRoundsToApprove: 0, roundsToApproveDistribution: {},
      escalations: 0, escalationRate: 0, stuckEvents: 0, stuckRate: 0,
      perBead: [], totalTokens: 0, totalCostUsd: 0, unpricedRuns: 0,
    });
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
});
