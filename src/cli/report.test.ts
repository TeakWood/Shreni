import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import { computeMetrics } from '../sthapathi/metrics';
import type { LoggedEvent } from '../sthapathi/activity-log';
import type { UsageEntry } from '../ext/types';
import { USAGE_SCHEMA_VERSION } from '../ext/types';

// ── module mocks (feeds live under homedir; mock the readers so the renderer +
//    resolution are exercised without touching the real ~/.shreni tree) ──────

const mockReadFileSync = vi.fn<(path: string) => string>();
vi.mock('fs', () => ({ readFileSync: (p: string) => mockReadFileSync(p) }));

const mockReadNotifications = vi.fn();
vi.mock('../sthapathi/notifications', () => ({
  readNotifications: (...a: unknown[]) => mockReadNotifications(...a),
}));

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const { renderReport, readFeeds, runReport } = await import('./report');

// ── fixtures ──────────────────────────────────────────────────────────────────

const K = 'myapp';
function ev(e: Omit<LoggedEvent, 'ts' | 'schemaVersion'>): LoggedEvent {
  return { ...e, ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1 } as LoggedEvent;
}
function taskDone(beadId: string, approved: boolean, rounds: number): LoggedEvent {
  return ev({ type: 'task_done', kshetra: K, beadId, title: beadId, approved, rounds });
}
function review(beadId: string, verdict: 'APPROVE' | 'REJECT', round: number): LoggedEvent {
  return ev({ type: 'viharapala_done', kshetra: K, beadId, round, verdict, score: 90, mustFix: [] });
}
function usage(beadId: string, over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    kshetra: K, beadId, runId: 'r', agent: 'silpi', provider: 'anthropic', model: 'm',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0, outcome: 'ok',
    ts: '2026-09-15T00:00:00.000Z', schemaVersion: USAGE_SCHEMA_VERSION, costUsd: 0, priced: true, ...over,
  };
}

const KSHETRA: KshetraConfig = {
  id: K,
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockReadNotifications.mockReturnValue([]);
  mockReadFileSync.mockImplementation(() => {
    const e = new Error('ENOENT') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    throw e;
  });
});

// ── renderReport (pure) ─────────────────────────────────────────────────────

describe('renderReport — empty log', () => {
  it('says nothing is recorded rather than a wall of zeros', () => {
    const out = renderReport(K, computeMetrics());
    expect(out).toContain('Run metrics: myapp');
    expect(out).toContain('No runs recorded yet.');
    expect(out).not.toContain('Total tasks');
  });

  it('does not hide in-flight review activity behind "no runs" (8xp)', () => {
    // A task mid-review: a viharapala_done round is logged but no task_done yet, so
    // totalTasks is 0 but totalRounds is not — the full report must render.
    const m = computeMetrics({ events: [review('b1', 'REJECT', 1)] });
    const out = renderReport(K, m);
    expect(out).not.toContain('No runs recorded yet.');
    expect(out).toContain('Reject rate');
  });
});

describe('renderReport — populated', () => {
  const m = computeMetrics({
    events: [
      taskDone('myapp-1', true, 1),
      taskDone('myapp-2', true, 2),
      taskDone('myapp-3', false, 3),
      review('myapp-1', 'APPROVE', 1),
      review('myapp-2', 'REJECT', 1),
      review('myapp-2', 'APPROVE', 2),
    ],
    usage: [
      usage('myapp-1', { inputTokens: 12000, outputTokens: 2000, costUsd: 0.1234 }),
      usage('myapp-1', { inputTokens: 5000, outputTokens: 1000, costUsd: 0.05, priced: false }),
      usage('myapp-2', { inputTokens: 3000, cacheReadTokens: 1000, costUsd: 0.02 }),
    ],
  });

  it('renders the task/quality summary', () => {
    const out = renderReport(K, m);
    expect(out).toContain('Total tasks         3');
    expect(out).toContain('Approved            2');
    // 1 reject over 3 rounds = 33.3%
    expect(out).toContain('Reject rate         33.3%  (1/3 rounds)');
    // approved rounds: 1 and 2 → avg 1.5, distribution 1×1, 2×1
    expect(out).toContain('Avg rounds→approve  1.5  (1×1, 2×1)');
  });

  it('renders a per-bead table with a totals row', () => {
    const out = renderReport(K, m);
    expect(out).toMatch(/BEAD\s+RUNS\s+INPUT\s+OUTPUT\s+CACHE-R\s+CACHE-W\s+TOKENS\s+COST/);
    expect(out).toContain('myapp-1');
    expect(out).toContain('TOTAL');
    // total tokens: (12000+2000)+(5000+1000)+(3000+1000) = 24,000
    expect(out).toContain('24,000');
  });

  it('flags cost as a lower bound when a run is unpriced', () => {
    const out = renderReport(K, m);
    expect(out).toContain('LOWER BOUND: 1 unpriced run ');
  });

  it('omits the unpriced note when every run is priced', () => {
    const priced = computeMetrics({ usage: [usage('b1', { inputTokens: 10, costUsd: 0.01 })] });
    expect(renderReport(K, priced)).not.toContain('LOWER BOUND');
  });
});

// ── readFeeds ────────────────────────────────────────────────────────────────

describe('readFeeds', () => {
  it('parses JSONL, skips corrupt lines, and treats a missing file as empty', () => {
    const evLine = JSON.stringify(taskDone('b1', true, 1));
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('activity.jsonl')) return `${evLine}\n{bad json\n\n${evLine}\n`;
      // usage.jsonl missing → ENOENT
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const feeds = readFeeds(K);
    expect(feeds.events).toHaveLength(2); // corrupt + blank lines skipped
    expect(feeds.usage).toEqual([]);
    expect(mockReadNotifications).toHaveBeenCalledWith(K);
  });
});

// ── runReport (resolution + wiring) ──────────────────────────────────────────

describe('runReport', () => {
  it('resolves via @mention and prints the report', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runReport({ args: ['@myapp'], flagKshetra: undefined, cwd: '/tmp', kshetras: [KSHETRA] });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('Run metrics: myapp');
    log.mockRestore();
  });

  it('throws for an unknown kshetra id', () => {
    expect(() =>
      runReport({ args: ['@nope'], flagKshetra: undefined, cwd: '/tmp', kshetras: [KSHETRA] }),
    ).toThrow(/Kshetra not found: nope/);
  });

  it('with turns:true emits the per-turn series as JSONL, not the table (epic 408/A1)', () => {
    const turnLine = (turnIndex: number, input: number, sidechain: boolean) => JSON.stringify({
      ...ev({
        type: 'turn_usage', kshetra: K, beadId: 'b1', agent: 'silpi', provider: 'anthropic', model: 'm',
        turnIndex, messageId: `m${turnIndex}`, inputTokens: input, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain,
      } as unknown as Omit<LoggedEvent, 'ts' | 'schemaVersion'>),
      runId: 'run-1', // computeTurnSeries groups by runId; a row without one is skipped
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('activity.jsonl')) return `${turnLine(0, 1000, false)}\n${turnLine(1, 2000, false)}\n`;
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runReport({ args: ['@myapp'], flagKshetra: undefined, cwd: '/tmp', kshetras: [KSHETRA], turns: true });
    const printed = log.mock.calls.map(c => c[0]);
    log.mockRestore();
    // One JSON row per turn; NOT the terminal table.
    expect(printed).toHaveLength(2);
    expect(JSON.parse(printed[0] as string)).toMatchObject({ turnIndex: 0, effectiveContext: 1000, sidechain: false });
    expect(JSON.parse(printed[1] as string)).toMatchObject({ turnIndex: 1, effectiveContext: 2000 });
    expect(printed.join('\n')).not.toContain('Run metrics');
  });
});

// ── time breakdown (epic hto / Study A3) ──────────────────────────────────────

function le(type: string, ts: string, over: Record<string, unknown> = {}): LoggedEvent {
  return { type, kshetra: K, lotId: 'lot-aaaa1111', ts, schemaVersion: 1, ...over } as LoggedEvent;
}
const LOT_EVENTS: LoggedEvent[] = [
  le('worker_started', '2026-09-15T00:00:00.000Z', { entrypoint: 'worker', subject: {}, process: {}, labels: {} }),
  le('run_usage', '2026-09-15T00:01:00.000Z', { beadId: 'b1', agent: 'silpi', provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, outcome: 'ok', durationMs: 120000 }),
  le('silpi_done', '2026-09-15T00:02:00.000Z', { beadId: 'b1', round: 1, summary: '', confidence: 1, files: [], lintPassed: true, testsPassed: true, gatesElapsedMs: 50000 }),
  le('task_done', '2026-09-15T00:05:00.000Z', { beadId: 'b1', title: 'b1', approved: true, rounds: 1 }),
];

describe('renderReport — time breakdown (epic hto)', () => {
  it('renders a per-lot breakdown with elapsed, sessions, and the unexplained residual', () => {
    const out = renderReport(K, computeMetrics({ events: LOT_EVENTS }));
    expect(out).toContain('Time breakdown (per lot)');
    expect(out).toContain('Lot lot-aaaa · worker · elapsed 5m 0s');
    expect(out).toContain('agent sessions    2m 0s');
    expect(out).toContain('gates             50.0s');
    expect(out).toContain('unexplained');
  });

  it('omits the breakdown for pre-B2 data (no lots)', () => {
    const out = renderReport(K, computeMetrics({ events: [taskDone('b1', true, 1)] }));
    expect(out).not.toContain('Time breakdown');
  });
});

describe('renderReport — drain outcomes (epic 7h3 / Study B3)', () => {
  it('renders each drain outcome per lot with its reason, exit code, and stalled beads', () => {
    const out = renderReport(K, computeMetrics({ events: [
      ev({ type: 'drain_finished', kshetra: K, lotId: 'lot-cccc', reason: 'stalled', scope: 'epic-1', exitCode: 10, counts: { filed: 1, merged: 2, open: 2 }, stalled: [{ beadId: 'mid', reason: 'needs-human' }, { beadId: 'dep', reason: 'blocked-by mid' }], outOfScopeFiled: [] }),
    ] }));
    expect(out).toContain('Drain outcomes (per lot)');
    expect(out).toContain('Lot lot-cccc · stalled (exit 10) · scope epic-1 · filed 1 merged 2 open 2');
    expect(out).toContain('mid — needs-human');
    expect(out).toContain('dep — blocked-by mid');
  });

  it('a stalled drain is never rendered as complete', () => {
    const out = renderReport(K, computeMetrics({ events: [
      ev({ type: 'drain_finished', kshetra: K, lotId: 'lot-dddd', reason: 'stalled', scope: null, exitCode: 10, counts: { filed: 0, merged: 0, open: 1 }, stalled: [{ beadId: 'x', reason: 'needs-human' }], outOfScopeFiled: [] }),
    ] }));
    expect(out).toContain('stalled (exit 10)');
    expect(out).not.toContain('complete');
  });

  it('omits the section when no drain ran', () => {
    const out = renderReport(K, computeMetrics({ events: [taskDone('b1', true, 1)] }));
    expect(out).not.toContain('Drain outcomes');
  });
});

describe('runReport --json (epic hto)', () => {
  it('emits the full metrics incl. per-lot shreniElapsedMs and breakdown fields', () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('activity.jsonl')) return LOT_EVENTS.map(e => JSON.stringify(e)).join('\n') + '\n';
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runReport({ args: [`@${K}`], flagKshetra: undefined, cwd: '/nowhere', kshetras: [KSHETRA], json: true });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    log.mockRestore();
    const parsed = JSON.parse(printed) as { kshetra: string; lots: Array<{ shreniElapsedMs: number; sessionsMs: number; unexplainedMs: number }> };
    expect(parsed.kshetra).toBe(K);
    expect(parsed.lots).toHaveLength(1);
    expect(parsed.lots[0].shreniElapsedMs).toBe(300000);
    expect(parsed.lots[0].sessionsMs).toBe(120000);
    expect(typeof parsed.lots[0].unexplainedMs).toBe('number');
  });

  it('exposes perSessionContext, one row per agent session of a run (Shreni-beads-6eg)', () => {
    const turnLine = (sessionId: string, agent: string, effective: number): string => JSON.stringify({
      type: 'turn_usage', kshetra: K, beadId: 'b1', agent, provider: 'anthropic', model: 'm', turnIndex: 0,
      messageId: `${sessionId}-0`, inputTokens: effective, cacheReadTokens: 0, cacheCreationTokens: 0,
      sidechain: false, sessionId, ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1, runId: 'run-1',
    });
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('activity.jsonl')) return `${turnLine('s-silpi', 'silpi', 1000)}\n${turnLine('s-vp', 'viharapala', 2000)}\n`;
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runReport({ args: [`@${K}`], flagKshetra: undefined, cwd: '/nowhere', kshetras: [KSHETRA], json: true });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    log.mockRestore();
    const parsed = JSON.parse(printed) as {
      perSessionContext: Array<{ sessionId: string; agent: string; peakContext: number; turns: number }>;
      perRunContext: Array<{ agent: string }>;
    };
    expect(parsed.perSessionContext.map(s => [s.sessionId, s.agent, s.peakContext, s.turns])).toEqual([
      ['s-silpi', 'silpi', 1000, 1],
      ['s-vp', 'viharapala', 2000, 1],
    ]);
    expect(parsed.perRunContext[0].agent).toBe('mixed');
  });
});

describe('renderReport — ablated section (epic 8wi / Study B1)', () => {
  it('lists ablated beads per switch when there is ablated data', () => {
    const out = renderReport(K, computeMetrics({
      events: [
        ev({ type: 'review_ablated', kshetra: K, beadId: 'b2', round: 1, ablations: ['review'] }),
        taskDone('b2', true, 1),
      ],
    }));
    expect(out).toContain('Ablated (excluded from reject rate');
    expect(out).toContain('Ablated beads       1');
    expect(out).toContain('b2');
    expect(out).toMatch(/review\s+1 bead/);
  });

  it('omits the ablated section entirely for a normal run (byte-identical)', () => {
    const out = renderReport(K, computeMetrics({ events: [taskDone('b1', true, 1)] }));
    expect(out).not.toContain('Ablated');
  });
});
