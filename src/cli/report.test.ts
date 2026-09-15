import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import { computeMetrics } from '../sthapathi/metrics';
import type { LoggedEvent } from '../sthapathi/activity-log';
import type { UsageEntry } from '../ext/types';

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
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0,
    ts: '2026-09-15T00:00:00.000Z', schemaVersion: 1, costUsd: 0, priced: true, ...over,
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
});
