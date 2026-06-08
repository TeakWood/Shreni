import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler, DEFAULT_INTERVAL_MS } from './index.js';
import type { SchedulerHooks } from './index.js';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: 'git@github.com:TeakWood/sishya.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: 'git@github.com:TeakWood/sishya-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const KSHETRA_B: KshetraConfig = { ...KSHETRA, id: 'mandira' };

const P0_TASK: Task = { id: 'bd-001', slug: 'p0-hotfix', title: 'P0 hotfix', status: 'pending', priority: 0 };
const P2_TASK: Task = { id: 'bd-002', slug: 'add-feature', title: 'Add feature', status: 'pending', priority: 2 };

function makeHooks(overrides: Partial<SchedulerHooks> = {}): SchedulerHooks {
  return {
    pickNext: vi.fn().mockResolvedValue(null),
    runTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Flush all pending microtasks (lets one await-level resolve)
function tick(): Promise<void> {
  return Promise.resolve();
}

describe('runCycle', () => {
  it('does nothing when pickNext returns null', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks();
    await scheduler.runCycle(KSHETRA, hooks);
    expect(hooks.runTask).not.toHaveBeenCalled();
  });

  it('calls runTask with the picked task when idle', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({ pickNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(hooks.runTask).toHaveBeenCalledWith(P2_TASK, KSHETRA);
  });

  it('sets active task during runTask and clears it after completion', async () => {
    const scheduler = createScheduler();
    let activeDuringTask: Task | undefined;
    const hooks = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockImplementation(async () => {
        activeDuringTask = scheduler.getActive(KSHETRA.id);
      }),
    });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(activeDuringTask).toEqual(P2_TASK);
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
  });

  it('clears active task even when runTask throws', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockRejectedValue(new Error('task failed')),
    });
    await expect(scheduler.runCycle(KSHETRA, hooks)).rejects.toThrow('task failed');
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
  });

  it('skips new task when kshetra is at capacity', async () => {
    const scheduler = createScheduler();
    let resolveTask!: () => void;
    const taskPromise = new Promise<void>(r => { resolveTask = r; });

    const hooks1 = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(taskPromise),
    });
    const cycle1 = scheduler.runCycle(KSHETRA, hooks1);
    await tick(); // let pickNext resolve and active be set

    const anotherTask: Task = { ...P2_TASK, id: 'bd-003' };
    const hooks2 = makeHooks({ pickNext: vi.fn().mockResolvedValue(anotherTask) });
    await scheduler.runCycle(KSHETRA, hooks2);
    expect(hooks2.runTask).not.toHaveBeenCalled();

    resolveTask();
    await cycle1;
  });

  it('P0 task preempts active non-P0 task', async () => {
    const scheduler = createScheduler();
    let resolveP2!: () => void;
    const p2Promise = new Promise<void>(r => { resolveP2 = r; });

    const hooks1 = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(p2Promise),
    });
    const cycle1 = scheduler.runCycle(KSHETRA, hooks1);
    await tick(); // active is now P2_TASK

    const hooks2 = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P0_TASK),
      runTask: vi.fn().mockResolvedValue(undefined),
    });
    await scheduler.runCycle(KSHETRA, hooks2);
    expect(hooks2.runTask).toHaveBeenCalledWith(P0_TASK, KSHETRA);

    resolveP2();
    await cycle1;
  });

  it('P0 task does not preempt another active P0 task', async () => {
    const scheduler = createScheduler();
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>(r => { resolveFirst = r; });

    const hooks1 = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P0_TASK),
      runTask: vi.fn().mockReturnValue(firstPromise),
    });
    const cycle1 = scheduler.runCycle(KSHETRA, hooks1);
    await tick();

    const anotherP0: Task = { ...P0_TASK, id: 'bd-p0-2' };
    const hooks2 = makeHooks({ pickNext: vi.fn().mockResolvedValue(anotherP0) });
    await scheduler.runCycle(KSHETRA, hooks2);
    expect(hooks2.runTask).not.toHaveBeenCalled();

    resolveFirst();
    await cycle1;
  });

  it('kshetras are isolated — active in one does not block another', async () => {
    const scheduler = createScheduler();
    let resolveA!: () => void;
    const aPromise = new Promise<void>(r => { resolveA = r; });

    const hooksA = makeHooks({
      pickNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(aPromise),
    });
    const cycleA = scheduler.runCycle(KSHETRA, hooksA);
    await tick();

    const hooksB = makeHooks({ pickNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA_B, hooksB);
    expect(hooksB.runTask).toHaveBeenCalledWith(P2_TASK, KSHETRA_B);

    resolveA();
    await cycleA;
  });

  it('getActive returns undefined before and after a cycle', async () => {
    const scheduler = createScheduler();
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
    const hooks = makeHooks({ pickNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
  });
});

describe('scheduleLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to 30s interval', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.scheduleLoop(KSHETRA, hooks);
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS - 1);
    expect(hooks.pickNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.pickNext).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fires on the given interval', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(250);
    expect(hooks.pickNext).toHaveBeenCalledTimes(2);
    stop();
  });

  it('returned function stops the loop', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(150);
    stop();
    const countAtStop = (hooks.pickNext as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect((hooks.pickNext as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAtStop);
  });

  it('swallows errors and continues looping', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hooks = makeHooks({
      pickNext: vi.fn().mockRejectedValue(new Error('bd error')),
    });

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(350);
    expect(consoleSpy).toHaveBeenCalled();
    // Loop should still be firing — error count should be > 1
    expect((hooks.pickNext as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    stop();
    consoleSpy.mockRestore();
  });
});

describe('start', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a loop for each kshetra', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.start([KSHETRA, KSHETRA_B], hooks, 100);
    await vi.advanceTimersByTimeAsync(150);

    const calls = (hooks.pickNext as ReturnType<typeof vi.fn>).mock.calls;
    const calledIds = calls.map((c: unknown[]) => (c[0] as KshetraConfig).id);
    expect(calledIds).toContain(KSHETRA.id);
    expect(calledIds).toContain(KSHETRA_B.id);

    stop();
  });

  it('returned function stops all loops', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.start([KSHETRA, KSHETRA_B], hooks, 100);
    await vi.advanceTimersByTimeAsync(150);
    stop();
    const countAtStop = (hooks.pickNext as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect((hooks.pickNext as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAtStop);
  });

  it('crash in one Kshetra loop does not stop the other (2cw.1 isolation)', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = createScheduler();

    // KSHETRA always errors; KSHETRA_B succeeds
    const pickNextA = vi.fn().mockRejectedValue(new Error('kshetra A crash'));
    const pickNextB = vi.fn().mockResolvedValue(null);

    const hooksA = makeHooks({ pickNext: pickNextA });
    const hooksB = makeHooks({ pickNext: pickNextB });

    // Use per-kshetra loops so their hooks are independent
    const stopA = scheduler.scheduleLoop(KSHETRA, hooksA, 100);
    const stopB = scheduler.scheduleLoop(KSHETRA_B, hooksB, 100);

    await vi.advanceTimersByTimeAsync(350);
    // B should have been called multiple times despite A's crashes
    expect(pickNextB.mock.calls.length).toBeGreaterThan(1);
    expect(consoleSpy).toHaveBeenCalled();

    stopA();
    stopB();
    consoleSpy.mockRestore();
  });
});