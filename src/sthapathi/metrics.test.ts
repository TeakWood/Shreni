import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeMetrics, computeTurnSeries, ESCALATION_EVENT, MIXED_AGENT, STUCK_EVENT } from './metrics.js';
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
      { runId: 'run-1', sessionId: null, beadId: 'b1', agent: 'silpi', turnIndex: 0, effectiveContext: 1000, sidechain: false, compactedAfter: false },
      { runId: 'run-1', sessionId: null, beadId: 'b1', agent: 'silpi', turnIndex: 0, effectiveContext: 300, sidechain: true, compactedAfter: false },
      { runId: 'run-1', sessionId: null, beadId: 'b1', agent: 'silpi', turnIndex: 1, effectiveContext: 2000, sidechain: false, compactedAfter: false },
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

// --- Shreni-beads-6eg: per-session context metrics ---
// A trimmed copy of a real run from the Bantu shakedown archive: every
// context-bearing event (task_claimed, run_started, run_usage, turn_usage,
// silpi_done, viharapala_done, task_done) of run ae11a3cd, which spans a Silpi, a
// Viharapala and a post-merge Parikshaka session. Long free-text fields (summary,
// files, mustFix) are blanked; nothing else is altered.
const GOLDEN_RUN = 'ae11a3cd-cf37-4944-99d6-e62d84e7600d';
function goldenEvents(): LoggedEvent[] {
  const path = join(__dirname, '__fixtures__', 'bantu-vvx-run.activity.jsonl');
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LoggedEvent);
}
// The same run as it would have been logged before Shreni-beads-228: no sessionId.
function legacyGoldenEvents(): LoggedEvent[] {
  return goldenEvents().map(e => {
    const { sessionId: _drop, ...rest } = e as LoggedEvent & { sessionId?: string };
    return rest as LoggedEvent;
  });
}

describe('computeMetrics — per-session context (Shreni-beads-6eg)', () => {
  it('(a) splits one run into its silpi / viharapala / parikshaka sessions (golden Bantu run)', () => {
    const m = computeMetrics({ events: goldenEvents() });
    expect(m.perSessionContext).toEqual([
      {
        sessionId: '60f66c61-967a-41a4-9655-27f2b3dea895', runId: GOLDEN_RUN, beadId: 'Bantu-beads-vvx', agent: 'silpi',
        peakContext: 175899, contextWindow: 200000, contextPressure: 0.8795, compactions: 0, turns: 94,
      },
      {
        sessionId: 'f8abbc5a-6692-4282-8e50-a36812988553', runId: GOLDEN_RUN, beadId: 'Bantu-beads-vvx', agent: 'viharapala',
        peakContext: 122069, contextWindow: 200000, contextPressure: 0.6103, compactions: 0, turns: 43,
      },
      {
        sessionId: 'cc343d48-e2c3-42c3-9bf9-bc593bc3cf39', runId: GOLDEN_RUN, beadId: 'Bantu-beads-vvx', agent: 'parikshaka',
        peakContext: 99944, contextWindow: 200000, contextPressure: 0.4997, compactions: 0, turns: 20,
      },
    ]);
  });

  it('(b) labels the run that spans several agents as mixed, keeping the merged per-run figures', () => {
    const m = computeMetrics({ events: goldenEvents() });
    expect(m.perRunContext).toEqual([
      {
        runId: GOLDEN_RUN, beadId: 'Bantu-beads-vvx', agent: MIXED_AGENT,
        peakContext: 175899, turns: 157, compactions: 0, contextWindow: 200000,
      },
    ]);
    expect(MIXED_AGENT).toBe('mixed');
  });

  it('(c) legacy data without sessionId falls back to one per-run row', () => {
    const m = computeMetrics({ events: legacyGoldenEvents() });
    expect(m.perRunContext).toEqual([
      {
        runId: GOLDEN_RUN, beadId: 'Bantu-beads-vvx', agent: MIXED_AGENT,
        peakContext: 175899, turns: 157, compactions: 0, contextWindow: 200000,
      },
    ]);
    expect(m.perSessionContext).toEqual([
      {
        sessionId: null, runId: GOLDEN_RUN, beadId: 'Bantu-beads-vvx', agent: MIXED_AGENT,
        peakContext: 175899, contextWindow: 200000, contextPressure: 0.8795, compactions: 0, turns: 157,
      },
    ]);
  });

  it('a single-agent run keeps its agent label on both the run and the session', () => {
    const m = computeMetrics({ events: [turn('b1', 'run-1', 0, 1000), runUsage('b1', 'run-1', { contextWindow: 200000 })] });
    expect(m.perRunContext[0].agent).toBe('silpi');
    expect(m.perSessionContext).toEqual([
      { sessionId: null, runId: 'run-1', beadId: 'b1', agent: 'silpi', peakContext: 1000, contextWindow: 200000, contextPressure: 0.005, compactions: 0, turns: 1 },
    ]);
  });

  it('attributes compactions to their own session and excludes sidechain turns per session', () => {
    const s = (e: LoggedEvent, sessionId: string): LoggedEvent => ({ ...e, sessionId } as LoggedEvent);
    const m = computeMetrics({
      events: [
        s(turn('b1', 'run-1', 0, 5000), 'sa'),
        s(turn('b1', 'run-1', 0, 999999, { sidechain: true }), 'sa'),
        s(compacted('b1', 'run-1', 0, 150000), 'sa'),
        s(turn('b1', 'run-1', 0, 7000, { agent: 'viharapala' }), 'sb'),
      ],
    });
    expect(m.perSessionContext.map(r => [r.sessionId, r.agent, r.peakContext, r.turns, r.compactions, r.contextPressure])).toEqual([
      ['sa', 'silpi', 150000, 1, 1, null],
      ['sb', 'viharapala', 7000, 1, 0, null],
    ]);
    expect(m.perRunContext[0]).toMatchObject({ agent: MIXED_AGENT, peakContext: 150000, turns: 2, compactions: 1 });
  });
});

describe('computeMetrics — overlapping post-merge Parikshaka (Shreni-beads-6eg)', () => {
  it('rolls a Parikshaka session stamped with the NEXT bead\'s runId up under its own bead', () => {
    const s = (e: LoggedEvent, sessionId: string): LoggedEvent => ({ ...e, sessionId } as LoggedEvent);
    const m = computeMetrics({
      events: [
        s(turn('b1', 'run-1', 0, 1000), 's1'),
        // b1's async Parikshaka is still running after b2 was claimed (run-2).
        s(turn('b2', 'run-2', 0, 2000), 's2'),
        s(turn('b1', 'run-2', 0, 9000, { agent: 'parikshaka' }), 's3'),
      ],
    });
    expect(m.perSessionContext.map(r => [r.beadId, r.runId, r.sessionId, r.agent])).toEqual([
      ['b1', 'run-1', 's1', 'silpi'],
      ['b1', 'run-2', 's3', 'parikshaka'],
      ['b2', 'run-2', 's2', 'silpi'],
    ]);
    expect(m.perBeadContext).toEqual([
      { beadId: 'b1', peakContext: 9000, turns: 2, compactions: 0, contextWindow: null },
      { beadId: 'b2', peakContext: 2000, turns: 1, compactions: 0, contextWindow: null },
    ]);
    // The per-run view still merges by runId (kept for compatibility).
    expect(m.perRunContext.find(r => r.runId === 'run-2')).toMatchObject({ beadId: 'b2', agent: MIXED_AGENT, turns: 2 });
  });
});

describe('computeTurnSeries — sessionId (Shreni-beads-6eg)', () => {
  it('(d) carries each turn\'s sessionId, in stream order (golden Bantu run)', () => {
    const rows = computeTurnSeries(goldenEvents());
    expect(rows).toHaveLength(157);
    const counts = new Map<string | null, number>();
    for (const r of rows) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1);
    expect([...counts]).toEqual([
      ['60f66c61-967a-41a4-9655-27f2b3dea895', 94],
      ['f8abbc5a-6692-4282-8e50-a36812988553', 43],
      ['cc343d48-e2c3-42c3-9bf9-bc593bc3cf39', 20],
    ]);
    expect(rows.every(r => r.runId === GOLDEN_RUN)).toBe(true);
  });

  it('sessionId is null on legacy turns', () => {
    expect(computeTurnSeries(legacyGoldenEvents()).every(r => r.sessionId === null)).toBe(true);
  });

  it('marks compactedAfter only in the compacting session, not the same turnIndex in a sibling session', () => {
    const s = (e: LoggedEvent, sessionId: string): LoggedEvent => ({ ...e, sessionId } as LoggedEvent);
    const rows = computeTurnSeries([
      s(turn('b1', 'run-1', 0, 1000), 'sa'),
      s(compacted('b1', 'run-1', 0, 150000), 'sa'),
      s(turn('b1', 'run-1', 0, 2000, { agent: 'viharapala' }), 'sb'),
    ]);
    expect(rows.map(r => [r.sessionId, r.compactedAfter])).toEqual([['sa', true], ['sb', false]]);
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
      perRunContext: [], perSessionContext: [], perBeadContext: [],
      lots: [],
      drains: [],
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

  it('surfaces drain outcomes per lot (epic 7h3 / Study B3)', () => {
    const m = computeMetrics({
      events: [
        ev({ type: 'drain_finished', kshetra: 'k', lotId: 'lot-A', reason: 'complete', scope: null, exitCode: 0, counts: { filed: 0, merged: 3, open: 0 }, stalled: [], outOfScopeFiled: [] }),
        ev({ type: 'drain_finished', kshetra: 'k', lotId: 'lot-B', reason: 'stalled', scope: 'epic-1', exitCode: 10, counts: { filed: 1, merged: 2, open: 2 }, stalled: [{ beadId: 'mid', reason: 'needs-human' }, { beadId: 'dep', reason: 'blocked-by mid' }], outOfScopeFiled: ['x-9'] }),
      ],
    });
    expect(m.drains).toHaveLength(2);
    expect(m.drains[0]).toMatchObject({ lotId: 'lot-A', reason: 'complete', exitCode: 0 });
    expect(m.drains[1]).toMatchObject({ lotId: 'lot-B', reason: 'stalled', exitCode: 10, scope: 'epic-1' });
    // A stalled drain records its per-bead reasons — never readable as complete.
    expect(m.drains[1].stalled).toEqual([{ beadId: 'mid', reason: 'needs-human' }, { beadId: 'dep', reason: 'blocked-by mid' }]);
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

  it('counts run_unmetered sessions (abort/spawn failure/token-less error) in role time (Shreni-beads-27a)', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      le('run_usage', '2026-09-15T00:01:00.000Z', { beadId: 'b1', agent: 'silpi', provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, outcome: 'ok', durationMs: 60000 }),
      // A timed-out silpi round: no usage record, but 90s of real time.
      le('run_unmetered', '2026-09-15T00:03:00.000Z', { beadId: 'b1', agent: 'silpi', provider: 'anthropic', model: 'm', cause: 'aborted', durationMs: 90000 }),
      le('task_done', '2026-09-15T00:05:00.000Z', { beadId: 'b1', title: 'b1', approved: false, rounds: 2 }),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.sessionsMs).toBe(150000);
    expect(lot.roles[0]).toMatchObject({ agent: 'silpi', sessions: 2, durationMs: 150000, unknownSessions: 0 });
    expect(lot.hasUnknownDurations).toBe(false);
    expect(lot.unexplainedMs).toBe(150000); // 300000 − 150000
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

  // ── concurrent work is not double-counted (Shreni-beads-qqq) ──
  const runStarted = (ts: string, agent: string, sessionId: string): LoggedEvent =>
    le('run_started', ts, { beadId: 'b1', agent, provider: 'anthropic', model: 'm', manifestHash: 'h', sessionId, runId: 'r1' });
  const runUsage = (ts: string, agent: string, sessionId: string, durationMs: number): LoggedEvent =>
    le('run_usage', ts, { beadId: 'b1', agent, provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, outcome: 'ok', durationMs, sessionId, runId: 'r1' });
  const phase = (ts: string, from: string, to: string, heldMs: number): LoggedEvent =>
    le('phase_changed', ts, { from, to, heldMs });
  const sync = (ts: string, durationMs: number): LoggedEvent => le('beads_synced', ts, { durationMs });
  const partSum = (lot: ReturnType<typeof computeMetrics>['lots'][number]): number =>
    lot.sessionsMs + lot.gatesMs + lot.mergeMs + lot.syncMs + lot.selectMs +
    lot.prepareMs + lot.idleMs + lot.waitingOnHumanMs;

  it('(a) does not double-count a background sync that runs inside a session', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'drain', subject: {}, process: {}, labels: {} }),
      phase('2026-09-15T00:00:00.000Z', 'PREPARING', 'WORKING', 0),
      runStarted('2026-09-15T00:00:00.000Z', 'silpi', 's1'),
      sync('2026-09-15T00:01:00.000Z', 6000),          // inside the session
      runUsage('2026-09-15T00:02:00.000Z', 'silpi', 's1', 120000),
      sync('2026-09-15T00:02:30.000Z', 5000),          // after it: overlaps nothing counted
      phase('2026-09-15T00:03:00.000Z', 'WORKING', 'IDLE', 180000),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.sessionsMs).toBe(120000);
    expect(lot.syncMs).toBe(5000);
    expect(lot.concurrentSyncMs).toBe(6000);
    expect(lot.concurrentSessionsMs).toBe(0);
    expect(lot.unexplainedMs).toBe(180000 - 125000);
    expect(partSum(lot) + (lot.unexplainedMs ?? 0)).toBe(lot.shreniElapsedMs);
  });

  it('counts two mutually-overlapping syncs outside other work once', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'drain', subject: {}, process: {}, labels: {} }),
      sync('2026-09-15T00:00:10.000Z', 6000),  // [4s,10s]
      sync('2026-09-15T00:00:12.000Z', 6000),  // [6s,12s] overlaps the first
      phase('2026-09-15T00:00:20.000Z', 'IDLE', 'SELECTING', 5000),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.syncMs).toBe(6000);
    expect(lot.concurrentSyncMs).toBe(6000);
  });

  it('(b) does not double-count a Parikshaka session that outlives WORKING into IDLE', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'drain', subject: {}, process: {}, labels: {} }),
      phase('2026-09-15T00:00:00.000Z', 'PREPARING', 'WORKING', 0),
      runStarted('2026-09-15T00:00:00.000Z', 'silpi', 's1'),
      runUsage('2026-09-15T00:01:00.000Z', 'silpi', 's1', 60000),
      // post-merge, not awaited: starts 10s before WORKING ends, runs 4m into IDLE
      runStarted('2026-09-15T00:01:00.000Z', 'parikshaka', 'p1'),
      phase('2026-09-15T00:01:10.000Z', 'WORKING', 'IDLE', 70000),
      runUsage('2026-09-15T00:05:10.000Z', 'parikshaka', 'p1', 250000),
      phase('2026-09-15T00:06:00.000Z', 'IDLE', 'SELECTING', 290000),
    ];
    const [lot] = computeMetrics({ events }).lots;
    // Only the 10s inside WORKING is on the serial timeline; IDLE owns the rest.
    expect(lot.sessionsMs).toBe(60000 + 10000);
    expect(lot.concurrentSessionsMs).toBe(240000);
    expect(lot.idleMs).toBe(290000);
    // Per-role totals keep the full duration (cost view).
    expect(lot.roles.find(r => r.agent === 'parikshaka')).toMatchObject({ sessions: 1, durationMs: 250000 });
    expect(lot.unexplainedMs).toBe(360000 - (70000 + 290000)); // 0 — no double count
    expect(partSum(lot) + (lot.unexplainedMs ?? 0)).toBe(lot.shreniElapsedMs);
  });

  it('does not double-count a Parikshaka that overlaps the NEXT bead\'s WORKING window', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'drain', subject: {}, process: {}, labels: {} }),
      phase('2026-09-15T00:00:00.000Z', 'PREPARING', 'WORKING', 0),
      runStarted('2026-09-15T00:00:00.000Z', 'silpi', 's1'),
      runUsage('2026-09-15T00:01:00.000Z', 'silpi', 's1', 60000),
      runStarted('2026-09-15T00:01:00.000Z', 'parikshaka', 'p1'),
      phase('2026-09-15T00:01:10.000Z', 'WORKING', 'IDLE', 70000),
      phase('2026-09-15T00:01:10.000Z', 'IDLE', 'SELECTING', 0),
      phase('2026-09-15T00:01:10.000Z', 'SELECTING', 'PREPARING', 0),
      phase('2026-09-15T00:01:10.000Z', 'PREPARING', 'WORKING', 0),
      runStarted('2026-09-15T00:01:10.000Z', 'silpi', 's2'),
      runUsage('2026-09-15T00:02:10.000Z', 'parikshaka', 'p1', 70000), // 60s inside bead 2's silpi
      runUsage('2026-09-15T00:03:10.000Z', 'silpi', 's2', 120000),
      phase('2026-09-15T00:03:10.000Z', 'WORKING', 'IDLE', 120000),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.sessionsMs).toBe(60000 + 10000 + 120000);
    expect(lot.concurrentSessionsMs).toBe(60000); // Parikshaka's overlap with s2
    expect(lot.unexplainedMs).toBe(0);
  });

  it('places a coalesced (late-emitted) idle over the whole IDLE span when classifying syncs', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
      phase('2026-09-15T00:00:00.000Z', 'PREPARING', 'WORKING', 0),
      phase('2026-09-15T00:01:00.000Z', 'WORKING', 'IDLE', 60000),
      sync('2026-09-15T00:02:00.000Z', 5000), // a background sync during the real idle
      // Empty polls coalesced and flushed at shutdown: 3m of idle, 1m of discarded
      // empty-poll select time, so [ts - heldMs, ts] would miss the sync.
      le('phase_changed', '2026-09-15T00:05:00.000Z', { from: 'IDLE', to: 'SELECTING', heldMs: 180000, polls: 4 }),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.syncMs).toBe(0);
    expect(lot.concurrentSyncMs).toBe(5000);
  });

  it('keeps other beads\' sessions serial while an escalated bead waits on a human', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'drain', subject: {}, process: {}, labels: {} }),
      phase('2026-09-15T00:01:00.000Z', 'PREPARING', 'WORKING', 0),
      runStarted('2026-09-15T00:01:00.000Z', 'silpi', 's1'),
      runUsage('2026-09-15T00:03:00.000Z', 'silpi', 's1', 120000),
      phase('2026-09-15T00:03:00.000Z', 'WORKING', 'IDLE', 120000),
    ];
    // b0 escalated before b1's session and was never answered within the lot.
    const notifications: Notification[] = [
      { ts: '2026-09-15T00:00:30.000Z', event: ESCALATION_EVENT, beadId: 'b0', message: 'e' },
    ];
    const [lot] = computeMetrics({ events, notifications }).lots;
    expect(lot.sessionsMs).toBe(120000);
    expect(lot.concurrentSessionsMs).toBe(0);
  });

  it('pairs sessions without a sessionId by run/bead/agent in order', () => {
    const events: LoggedEvent[] = [
      le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'drain', subject: {}, process: {}, labels: {} }),
      phase('2026-09-15T00:00:00.000Z', 'PREPARING', 'WORKING', 0),
      le('run_started', '2026-09-15T00:00:00.000Z', { beadId: 'b1', agent: 'silpi', provider: 'a', model: 'm', manifestHash: 'h', runId: 'r1' }),
      le('run_unmetered', '2026-09-15T00:00:30.000Z', { beadId: 'b1', agent: 'silpi', provider: 'a', model: 'm', cause: 'aborted', durationMs: 30000, runId: 'r1' }),
      phase('2026-09-15T00:00:20.000Z', 'WORKING', 'IDLE', 20000),
      phase('2026-09-15T00:01:00.000Z', 'IDLE', 'SELECTING', 40000),
    ];
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.sessionsMs).toBe(20000);
    expect(lot.concurrentSessionsMs).toBe(10000);
  });

  it('(c) golden: the archived Bantu lot cf5d9478 reconciles to ~+78,862 ms (+2.08%)', () => {
    // Trimmed from the archived shakedown feed (2026-09-23): only the events the
    // breakdown reads, with identifiers and free text redacted.
    const path = join(__dirname, '__fixtures__', 'lot-cf5d9478-golden.jsonl');
    const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LoggedEvent);
    const [lot] = computeMetrics({ events }).lots;
    expect(lot.shreniElapsedMs).toBe(3785836);
    // Per-role totals are unchanged (cost view): 2,010,194 + 639,000 + 270,772.
    expect(lot.roles.reduce((a, r) => a + r.durationMs, 0)).toBe(2919966);
    // Parikshaka: 8,339 ms inside WORKING, the rest overlaps the drain's IDLE.
    expect(lot.sessionsMs).toBe(2657533);
    expect(lot.concurrentSessionsMs).toBe(262433);
    // 2 of 19 syncs sit outside every other counted interval.
    expect(lot.syncMs).toBe(12779);
    expect(lot.concurrentSyncMs).toBe(104329);
    expect(lot).toMatchObject({ gatesMs: 498186, mergeMs: 3815, selectMs: 6926, prepareMs: 251914, idleMs: 275821 });
    expect(lot.unexplainedMs).toBe(78862);
    expect(lot.unexplainedPct).toBeCloseTo(0.0208, 4);
    expect(partSum(lot) + (lot.unexplainedMs ?? 0)).toBe(lot.shreniElapsedMs);
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
