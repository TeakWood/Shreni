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

const { driveDrain, collectEpicScope } = await import('./drain');
type DrainDriver = import('./drain').DrainDriver;

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
  const driver: DrainDriver = {
    runtime,
    openInScope: vi.fn(async () => {
      log.push(`open:${(script.openInScope ?? []).length}`);
      return script.openInScope ?? [];
    }),
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

  it('exits 10 (stalled) when open in-scope beads remain', async () => {
    const { driver } = fakeDriver({ outcomes: ['no-work'], openInScope: ['needs-human-1', 'blocked-2'] });
    const result = await driveDrain(driver, { intervalMs: 100, signalled: noSignal }, noDelay);
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled' });
    expect(result.openInScope).toEqual(['needs-human-1', 'blocked-2']);
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
