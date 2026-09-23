import { describe, it, expect, vi } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import type { Scheduler, CycleOutcome } from '../sthapathi/index';
import type { WorkerRuntime } from './worker-runtime';

// bd is mocked only for the collectEpicScope suite; driveDrain is pure and needs
// no mocks. Declare the mock up front so the import below binds to it.
const mockChildren = vi.fn<(id: string) => Promise<string>>();
vi.mock('../sthapathi/beads', () => ({
  bd: () => ({ children: mockChildren }),
}));

const { driveDrain, collectEpicScope, drainResultJson, formatDrainResult, openBeadIds } = await import('./drain');
type DrainDriver = import('./drain').DrainDriver;
type DrainResult = import('./drain').DrainResult;
type StalledBead = import('./drain-classify').StalledBead;

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

// A scriptable driver whose runCycle replays `outcomes` (repeating the last one),
// with per-call log for ordering assertions. isInFlight/isHealing/readyInScope
// are supplied as callbacks so a test can vary them across iterations.
function fakeDriver(script: {
  outcomes: CycleOutcome[];
  isInFlight?: () => boolean;
  isHealing?: () => boolean;
  openInScope?: string[];
  stalled?: StalledBead[];
}): { driver: DrainDriver; log: string[]; cycles: () => number } {
  const log: string[] = [];
  let i = 0;
  const runCycle = vi.fn(async () => {
    const o = script.outcomes[Math.min(i, script.outcomes.length - 1)];
    i++;
    log.push(`cycle:${o}`);
    return o;
  });
  const scheduler = { runCycle } as unknown as Scheduler;
  const runtime: WorkerRuntime = {
    kshetra: KSHETRA,
    scheduler,
    hooks: {} as WorkerRuntime['hooks'],
    startup: vi.fn(async () => { log.push('startup'); return 0; }),
    sync: vi.fn(async () => { log.push('sync'); }),
    startTimers: () => () => {},
    isInFlight: () => script.isInFlight?.() ?? false,
    isHealing: () => script.isHealing?.() ?? false,
  };
  const openIds = script.openInScope ?? [];
  const driver: DrainDriver = {
    runtime,
    openInScope: vi.fn(async () => {
      log.push(`open:${openIds.length}`);
      return openIds;
    }),
    classify: vi.fn(async (ids: string[]) => {
      log.push(`classify:${ids.length}`);
      return script.stalled ?? ids.map(id => ({ beadId: id, category: 'open' as const, reason: 'open' }));
    }),
    counts: vi.fn(async () => ({ filed: 0, merged: 0, outOfScopeFiled: [] })),
  };
  return { driver, log, cycles: () => i };
}

const noDelay = vi.fn(async () => {});
const noSignal = () => undefined;

describe('driveDrain', () => {
  it('works a chain of ready beads then exits 0 (complete)', async () => {
    const { driver, log } = fakeDriver({ outcomes: ['ran', 'ran', 'ran', 'no-work'], openInScope: [] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result).toMatchObject({ exitCode: 0, reason: 'complete', openInScope: [] });
    // 'ran' re-ticks immediately (no delay); the trailing 'no-work' triggers the
    // exit sequence: final sync → one probe cycle (still no-work) → classify.
    expect(log).toEqual(['startup', 'cycle:ran', 'cycle:ran', 'cycle:ran', 'cycle:no-work', 'sync', 'cycle:no-work', 'open:0']);
    expect(noDelay).not.toHaveBeenCalled();
  });

  it('runs startup (recoverKshetra) before the first cycle', async () => {
    const { driver, log } = fakeDriver({ outcomes: ['no-work'], openInScope: [] });
    await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(log[0]).toBe('startup');
    expect(log.indexOf('startup')).toBeLessThan(log.indexOf('cycle:no-work'));
  });

  it('syncs the ledger BEFORE returning (final sync precedes classification)', async () => {
    const { driver, log } = fakeDriver({ outcomes: ['no-work'], openInScope: ['b1'] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result.reason).toBe('stalled');
    // sync happens, then the open-in-scope classification read.
    expect(log.indexOf('sync')).toBeLessThan(log.indexOf('open:1'));
  });

  it('picks up a bead a backfill filed during the final sync (probe cycle resumes the loop)', async () => {
    // After the first 'no-work' + sync, the probe cycle returns 'ran' — a backfill
    // surfaced fresh work — so the loop resumes instead of exiting. The second
    // exit attempt's probe is 'no-work', so it drains.
    const { driver, log } = fakeDriver({ outcomes: ['ran', 'no-work', 'ran', 'no-work'], openInScope: [] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result.exitCode).toBe(0);
    // Two exit attempts ⇒ two final syncs; the middle probe 'ran' resumed the loop.
    expect(log.filter(l => l === 'sync')).toHaveLength(2);
    expect(log.filter(l => l === 'cycle:ran')).toHaveLength(2);
  });

  it("waits an interval while work is still in flight, then re-checks", async () => {
    let inFlight = true;
    const { driver } = fakeDriver({
      outcomes: ['no-work'],
      isInFlight: () => inFlight,
      openInScope: [],
    });
    const delay = vi.fn(async () => { inFlight = false; }); // settle after one wait
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, delay);
    expect(delay).toHaveBeenCalledWith(100);
    expect(result.exitCode).toBe(0);
  });

  it("backs off a full interval on 'declined' (never hot-loops the failure path)", async () => {
    // 'declined' paces on the interval and does NOT run the exit sequence; the
    // watchdog-paused state then surfaces as 'no-work' and the still-open bead is
    // classified stalled.
    const { driver, log } = fakeDriver({ outcomes: ['declined', 'no-work'], openInScope: ['b1'] });
    const delay = vi.fn(async () => {});
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, delay);
    expect(delay).toHaveBeenCalledWith(100); // interval backoff on 'declined'
    // No sync ran on the 'declined' iteration — the exit sequence was not entered.
    expect(log.indexOf('sync')).toBeGreaterThan(log.indexOf('cycle:no-work'));
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled', openInScope: ['b1'] });
  });

  it('exits 10 (stalled) with per-bead classification when open beads remain', async () => {
    const stalled: StalledBead[] = [
      { beadId: 'mid', category: 'needs-human', reason: 'needs-human' },
      { beadId: 'dep', category: 'blocked-by', reason: 'blocked-by mid' },
    ];
    const { driver } = fakeDriver({ outcomes: ['no-work'], openInScope: ['mid', 'dep'], stalled });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled' });
    expect(result.openInScope).toEqual(['mid', 'dep']);
    expect(result.stalled).toEqual(stalled); // classification carried through
  });

  it('exits 11 (budget) when any open bead is classified budget', async () => {
    const stalled: StalledBead[] = [
      { beadId: 'b1', category: 'budget', reason: 'bead b1 has spent $5 of its $5 per-bead budget cap' },
    ];
    const { driver } = fakeDriver({ outcomes: ['no-work'], openInScope: ['b1'], stalled });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result).toMatchObject({ exitCode: 11, reason: 'budget' });
  });

  it('never classifies as complete while open beads remain (stalled ≠ complete)', async () => {
    const { driver } = fakeDriver({ outcomes: ['no-work'], openInScope: ['x'] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result.reason).not.toBe('complete');
    expect(result.exitCode).not.toBe(0);
  });

  it('stops cleanly on SIGTERM and exits 143, leaving classification to recovery', async () => {
    let cycles = 0;
    const { driver } = fakeDriver({ outcomes: ['ran'] });
    // Signalled after the first cycle: the post-cycle check-point breaks the loop.
    const signalled = (): NodeJS.Signals | undefined => (cycles++ >= 1 ? 'SIGTERM' : undefined);
    const result = await driveDrain(driver, { intervalMs: 100, signalled }, noDelay);
    expect(result).toMatchObject({ exitCode: 143, reason: 'signal', signal: 'SIGTERM' });
  });

  it('exits 130 on SIGINT', async () => {
    const signalled = (): NodeJS.Signals => 'SIGINT';
    const { driver } = fakeDriver({ outcomes: ['no-work'] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled }, noDelay);
    expect(result.exitCode).toBe(130);
  });
});

// --max-cycles (Shreni-beads-nhw): a cycle cap is a STOP CONDITION on the real
// loop — it must stop driving at the cap and still run the full exit sequence.
describe('driveDrain — maxCycles', () => {
  const READY = (id: string): StalledBead => ({ beadId: id, category: 'ready-but-unworked', reason: 'READY BUT UNWORKED — investigate (should not happen)' });

  it('stops after n cycles even with work still flowing, then runs the exit sequence', async () => {
    const { driver, log, cycles } = fakeDriver({
      outcomes: ['ran'], openInScope: ['b2', 'h1'],
      stalled: [READY('b2'), { beadId: 'h1', category: 'needs-human', reason: 'needs-human' }],
    });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 2 }, noDelay);
    expect(cycles()).toBe(2);
    // No extra probe cycle past the cap; classification still runs.
    expect(log).toEqual(['startup', 'cycle:ran', 'cycle:ran', 'open:2', 'classify:2']);
    // A ready bead left by the cap is expected, not the anomaly: relabelled
    // 'not-reached', and it makes the drain exit 12 'capped'.
    expect(result).toMatchObject({ exitCode: 12, reason: 'capped', openInScope: ['b2', 'h1'] });
    expect(result.stalled).toEqual([
      { beadId: 'b2', category: 'not-reached', reason: 'ready — not reached before the --max-cycles cap' },
      { beadId: 'h1', category: 'needs-human', reason: 'needs-human' },
    ]);
  });

  it('a capped stop leaving only unworkable beads is stalled (10), not capped', async () => {
    const { driver } = fakeDriver({
      outcomes: ['ran'], openInScope: ['h1'],
      stalled: [{ beadId: 'h1', category: 'needs-human', reason: 'needs-human' }],
    });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, noDelay);
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled' });
  });

  it('an UNCAPPED drain still flags a ready-but-unworked bead as the anomaly', async () => {
    const { driver } = fakeDriver({ outcomes: ['no-work'], openInScope: ['b1'], stalled: [READY('b1')] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled' });
    expect(result.stalled[0].category).toBe('ready-but-unworked');
  });

  it('a one-cycle cap that works the last bead exits 0 (complete)', async () => {
    const { driver, cycles } = fakeDriver({ outcomes: ['ran'], openInScope: [] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, noDelay);
    expect(cycles()).toBe(1);
    expect(result).toMatchObject({ exitCode: 0, reason: 'complete' });
  });

  it("a cap hit on a 'no-work' cycle skips the probe; unworkable open beads classify as stalled", async () => {
    const { driver, log } = fakeDriver({ outcomes: ['no-work'], openInScope: ['b1'] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, noDelay);
    expect(log).toEqual(['startup', 'cycle:no-work', 'open:1', 'classify:1']);
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled' });
  });

  it("a cap hit on 'no-work' while a backfill filed a ready bead reads capped, not the anomaly", async () => {
    const { driver } = fakeDriver({ outcomes: ['no-work'], openInScope: ['t1'], stalled: [READY('t1')] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, noDelay);
    expect(result).toMatchObject({ exitCode: 12, reason: 'capped' });
    expect(result.stalled[0].category).toBe('not-reached');
  });

  it('counts the post-sync probe cycle toward the cap', async () => {
    const { driver, log, cycles } = fakeDriver({ outcomes: ['no-work', 'ran', 'ran'], openInScope: ['b3'], stalled: [READY('b3')] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 2 }, noDelay);
    expect(cycles()).toBe(2);
    expect(log).toEqual(['startup', 'cycle:no-work', 'sync', 'cycle:ran', 'open:1', 'classify:1']);
    expect(result.reason).toBe('capped');
  });

  it("a capped 'declined' cycle does not back off — it exits capped", async () => {
    const delay = vi.fn(async () => {});
    const { driver } = fakeDriver({ outcomes: ['declined'], openInScope: ['b1'], stalled: [READY('b1')] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, delay);
    expect(delay).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 12, reason: 'capped' });
  });

  it('waits for in-flight async work (a Parikshaka backfill) to settle before classifying', async () => {
    let inFlight = true;
    const { driver, log } = fakeDriver({ outcomes: ['ran'], isInFlight: () => inFlight, openInScope: [] });
    const delay = vi.fn(async () => { log.push('delay'); inFlight = false; });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, delay);
    expect(log).toEqual(['startup', 'cycle:ran', 'delay', 'open:0']);
    expect(result.exitCode).toBe(0);
  });

  it('a budget denial outranks the cap (exit 11)', async () => {
    const stalled: StalledBead[] = [{ beadId: 'b1', category: 'budget', reason: 'budget cap' }];
    const { driver } = fakeDriver({ outcomes: ['ran'], openInScope: ['b1'], stalled });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal, maxCycles: 1 }, noDelay);
    expect(result).toMatchObject({ exitCode: 11, reason: 'budget' });
  });

  it('a signal still wins over the cap', async () => {
    let n = 0;
    const signalled = (): NodeJS.Signals | undefined => (n++ >= 1 ? 'SIGINT' : undefined);
    const { driver } = fakeDriver({ outcomes: ['ran'], openInScope: ['b1'] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled, maxCycles: 1 }, noDelay);
    expect(result).toMatchObject({ exitCode: 130, reason: 'signal' });
  });
});

describe('openBeadIds', () => {
  const row = (id: string, type: string) => ({ id, title: id, priority: 2, status: 'open', issue_type: type });
  it('drops epic containers (they stay open after children close and are never worked)', () => {
    // The scope root epic + a sub-epic must not count as stalled work.
    const json = JSON.stringify([row('epic-1', 'epic'), row('t1', 'task'), row('sub-epic', 'epic'), row('t2', 'bug')]);
    expect(openBeadIds(json)).toEqual(['t1', 't2']);
  });
  it('applies the scope filter', () => {
    const json = JSON.stringify([row('t1', 'task'), row('t2', 'task'), row('t3', 'task')]);
    expect(openBeadIds(json, new Set(['t1', 't3']))).toEqual(['t1', 't3']);
  });
  it('returns [] for a malformed payload', () => {
    expect(openBeadIds('not json')).toEqual([]);
  });
});

describe('collectEpicScope', () => {
  it('walks bd children breadth-first into the full subtree id set', async () => {
    // epic → [c1, c2]; c1 → [g1]; c2, g1 → none.
    mockChildren.mockImplementation(async (id: string) => {
      if (id === 'epic') return JSON.stringify([{ id: 'c1', title: 'c1', priority: 2, status: 'open' }, { id: 'c2', title: 'c2', priority: 2, status: 'open' }]);
      if (id === 'c1') return JSON.stringify([{ id: 'g1', title: 'g1', priority: 2, status: 'open' }]);
      return '[]';
    });
    const scope = await collectEpicScope(KSHETRA, 'epic');
    expect([...scope].sort()).toEqual(['c1', 'c2', 'epic', 'g1']);
  });

  it('tolerates an unreadable children payload (leaf contributes nothing)', async () => {
    mockChildren.mockImplementation(async (id: string) =>
      id === 'epic' ? JSON.stringify([{ id: 'c1', title: 'c1', priority: 2, status: 'open' }]) : 'not json',
    );
    const scope = await collectEpicScope(KSHETRA, 'epic');
    expect([...scope].sort()).toEqual(['c1', 'epic']);
  });
});

const STALLED_RESULT: DrainResult = {
  exitCode: 10,
  reason: 'stalled',
  openInScope: ['mid', 'dep'],
  stalled: [
    { beadId: 'mid', category: 'needs-human', reason: 'needs-human' },
    { beadId: 'dep', category: 'blocked-by', reason: 'blocked-by mid' },
  ],
  kshetra: 'myapp',
  lotId: 'abcdef0123456789',
  scope: 'epic-1',
  labels: { arm: 'A' },
  maxCycles: null,
  elapsedMs: 42_000,
  counts: { filed: 1, merged: 2, open: 2 },
  outOfScopeFiled: ['x-99'],
};

describe('drainResultJson', () => {
  it('carries every field of the summary (machine-readable)', () => {
    const j = JSON.parse(drainResultJson(STALLED_RESULT));
    expect(j).toMatchObject({
      kshetra: 'myapp', lotId: 'abcdef0123456789', reason: 'stalled', exitCode: 10,
      scope: 'epic-1', labels: { arm: 'A' }, elapsedMs: 42_000,
      counts: { filed: 1, merged: 2, open: 2 }, outOfScopeFiled: ['x-99'],
    });
    expect(j.stalled).toEqual([
      { beadId: 'mid', category: 'needs-human', reason: 'needs-human' },
      { beadId: 'dep', category: 'blocked-by', reason: 'blocked-by mid' },
    ]);
  });

  it('includes signal only when interrupted', () => {
    expect(JSON.parse(drainResultJson(STALLED_RESULT)).signal).toBeUndefined();
    const sig: DrainResult = { ...STALLED_RESULT, reason: 'signal', exitCode: 143, signal: 'SIGTERM' };
    expect(JSON.parse(drainResultJson(sig)).signal).toBe('SIGTERM');
  });
});

describe('formatDrainResult', () => {
  it('names each stalled bead with its reason and the out-of-scope filed beads', () => {
    const text = formatDrainResult(STALLED_RESULT);
    expect(text).toContain('drain stalled for "myapp"');
    expect(text).toContain('mid — needs-human');
    expect(text).toContain('dep — blocked-by mid');
    expect(text).toContain('out-of-scope beads filed: x-99');
    expect(text).toContain('filed 1 · merged 2 · open 2');
  });

  it('renders a budget stop naming the exit code', () => {
    const budget: DrainResult = { ...STALLED_RESULT, reason: 'budget', exitCode: 11 };
    expect(formatDrainResult(budget)).toContain('budget policy denied work (exit 11)');
  });

  it('renders a capped stop naming the cap and the exit code', () => {
    const capped: DrainResult = { ...STALLED_RESULT, reason: 'capped', exitCode: 12, maxCycles: 1 };
    const text = formatDrainResult(capped);
    expect(text).toContain('after 1 cycle(s) (--max-cycles)');
    expect(text).toContain('2 bead(s) still open (exit 12)');
    expect(JSON.parse(drainResultJson(capped)).maxCycles).toBe(1);
  });

  it('renders complete with no stalled section', () => {
    const done: DrainResult = { ...STALLED_RESULT, reason: 'complete', exitCode: 0, openInScope: [], stalled: [], outOfScopeFiled: [] };
    const text = formatDrainResult(done);
    expect(text).toContain('drain complete for "myapp"');
    expect(text).not.toContain('stalled beads');
  });
});
