import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler, DEFAULT_INTERVAL_MS } from './index.js';
import type { SchedulerHooks } from './index.js';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git', mode: 'embedded' },
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
    selectNext: vi.fn().mockResolvedValue(null),
    // Default PREPARE is a pass-through: whatever SELECT returns is worked. Tests
    // that exercise preflight/health rejection override this to return null.
    prepareTask: vi.fn().mockImplementation(async (task: Task) => task),
    runTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Flush all pending microtasks (lets one await-level resolve)
function tick(): Promise<void> {
  return Promise.resolve();
}

describe('runCycle', () => {
  it('does nothing when selectNext returns null', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks();
    await scheduler.runCycle(KSHETRA, hooks);
    expect(hooks.prepareTask).not.toHaveBeenCalled();
    expect(hooks.runTask).not.toHaveBeenCalled();
  });

  it('selects → prepares → works the picked task when idle', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(hooks.prepareTask).toHaveBeenCalledWith(P2_TASK, KSHETRA);
    expect(hooks.runTask).toHaveBeenCalledWith(P2_TASK, KSHETRA);
  });

  it('does not run the task when prepareTask rejects it (returns null)', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      prepareTask: vi.fn().mockResolvedValue(null), // preflight/health rejected
    });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(hooks.runTask).not.toHaveBeenCalled();
    expect(scheduler.getPhase(KSHETRA.id)).toBe('IDLE');
  });

  it('works the prepared task (PREPARE may substitute the task object)', async () => {
    const scheduler = createScheduler();
    const claimed: Task = { ...P2_TASK, status: 'in_progress' };
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      prepareTask: vi.fn().mockResolvedValue(claimed),
    });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(hooks.runTask).toHaveBeenCalledWith(claimed, KSHETRA);
  });

  it('sets active task during runTask and clears it after completion', async () => {
    const scheduler = createScheduler();
    let activeDuringTask: Task | undefined;
    let phaseDuringTask: string | undefined;
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockImplementation(async () => {
        activeDuringTask = scheduler.getActive(KSHETRA.id);
        phaseDuringTask = scheduler.getPhase(KSHETRA.id);
      }),
    });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(activeDuringTask).toEqual(P2_TASK);
    expect(phaseDuringTask).toBe('WORKING');
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
    expect(scheduler.getPhase(KSHETRA.id)).toBe('IDLE');
  });

  it('clears active task and returns to IDLE even when runTask throws', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockRejectedValue(new Error('task failed')),
    });
    await expect(scheduler.runCycle(KSHETRA, hooks)).rejects.toThrow('task failed');
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
    expect(scheduler.getPhase(KSHETRA.id)).toBe('IDLE');
  });

  it('skips a new cycle while one is in flight — no select/prepare while WORKING', async () => {
    const scheduler = createScheduler();
    let resolveTask!: () => void;
    const taskPromise = new Promise<void>(r => { resolveTask = r; });

    const hooks1 = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(taskPromise),
    });
    const cycle1 = scheduler.runCycle(KSHETRA, hooks1);
    await tick(); // phase is now WORKING, active set

    // A second cycle must not even SELECT or PREPARE — the jhl regression: a poll
    // must not run prepareTask (which checks out main) under an in-flight agent.
    const anotherTask: Task = { ...P2_TASK, id: 'bd-003' };
    const hooks2 = makeHooks({ selectNext: vi.fn().mockResolvedValue(anotherTask) });
    await scheduler.runCycle(KSHETRA, hooks2);
    expect(hooks2.selectNext).not.toHaveBeenCalled();
    expect(hooks2.prepareTask).not.toHaveBeenCalled();
    expect(hooks2.runTask).not.toHaveBeenCalled();

    resolveTask();
    await cycle1;
  });

  it('does not preempt — a P0 is skipped while any task is in flight (defers to idle)', async () => {
    const scheduler = createScheduler();
    let resolveP2!: () => void;
    const p2Promise = new Promise<void>(r => { resolveP2 = r; });

    const hooks1 = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(p2Promise),
    });
    const cycle1 = scheduler.runCycle(KSHETRA, hooks1);
    await tick(); // WORKING on P2_TASK

    const hooks2 = makeHooks({ selectNext: vi.fn().mockResolvedValue(P0_TASK) });
    await scheduler.runCycle(KSHETRA, hooks2);
    expect(hooks2.runTask).not.toHaveBeenCalled();
    expect(scheduler.getActive(KSHETRA.id)).toEqual(P2_TASK);

    resolveP2();
    await cycle1;
  });

  it('kshetras are isolated — active in one does not block another', async () => {
    const scheduler = createScheduler();
    let resolveA!: () => void;
    const aPromise = new Promise<void>(r => { resolveA = r; });

    const hooksA = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(aPromise),
    });
    const cycleA = scheduler.runCycle(KSHETRA, hooksA);
    await tick();

    const hooksB = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA_B, hooksB);
    expect(hooksB.runTask).toHaveBeenCalledWith(P2_TASK, KSHETRA_B);

    resolveA();
    await cycleA;
  });

  it('getActive/getPhase are IDLE before and after a cycle', async () => {
    const scheduler = createScheduler();
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
    expect(scheduler.getPhase(KSHETRA.id)).toBe('IDLE');
    const hooks = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(scheduler.getActive(KSHETRA.id)).toBeUndefined();
    expect(scheduler.getPhase(KSHETRA.id)).toBe('IDLE');
  });

  it('notifies onPhase of each transition (for cross-process persistence)', async () => {
    const seen: string[] = [];
    const scheduler = createScheduler({ onPhase: (_id, p) => seen.push(p) });
    const hooks = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(seen).toEqual(['SELECTING', 'PREPARING', 'WORKING', 'IDLE']);
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
    expect(hooks.selectNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.selectNext).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fires on the given interval', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(250);
    expect(hooks.selectNext).toHaveBeenCalledTimes(2);
    stop();
  });

  it('returned function stops the loop', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks();

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(150);
    stop();
    const countAtStop = (hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect((hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAtStop);
  });

  it('swallows errors and continues looping', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hooks = makeHooks({
      selectNext: vi.fn().mockRejectedValue(new Error('bd error')),
    });

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(350);
    expect(consoleSpy).toHaveBeenCalled();
    // Loop should still be firing — error count should be > 1
    expect((hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    stop();
    consoleSpy.mockRestore();
  });

  it('does not start a new cycle while the previous one is still in flight', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    // Hold runTask open so the first cycle stays in flight across several ticks.
    let releaseTask: () => void = () => {};
    const runTask = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => { releaseTask = resolve; }),
    );
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask,
    });

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);

    // Several intervals elapse, but the first cycle's runTask is still pending,
    // so selectNext must NOT be called again (no overlapping pickup → no checkout
    // race against the in-flight agent).
    await vi.advanceTimersByTimeAsync(350);
    expect(hooks.selectNext).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledTimes(1);

    // Once the in-flight task resolves, the loop is free to pick up again.
    releaseTask();
    await vi.advanceTimersByTimeAsync(100);
    expect((hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    stop();
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

    const calls = (hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls;
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
    const countAtStop = (hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect((hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAtStop);
  });

  it('crash in one Kshetra loop does not stop the other (2cw.1 isolation)', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = createScheduler();

    // KSHETRA always errors; KSHETRA_B succeeds
    const selectNextA = vi.fn().mockRejectedValue(new Error('kshetra A crash'));
    const selectNextB = vi.fn().mockResolvedValue(null);

    const hooksA = makeHooks({ selectNext: selectNextA });
    const hooksB = makeHooks({ selectNext: selectNextB });

    // Use per-kshetra loops so their hooks are independent
    const stopA = scheduler.scheduleLoop(KSHETRA, hooksA, 100);
    const stopB = scheduler.scheduleLoop(KSHETRA_B, hooksB, 100);

    await vi.advanceTimersByTimeAsync(350);
    // B should have been called multiple times despite A's crashes
    expect(selectNextB.mock.calls.length).toBeGreaterThan(1);
    expect(consoleSpy).toHaveBeenCalled();

    stopA();
    stopB();
    consoleSpy.mockRestore();
  });
});