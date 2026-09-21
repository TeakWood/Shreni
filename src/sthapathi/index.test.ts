import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture phase_changed emits (epic hto) while keeping the rest of activity-log real.
const { emitSpy } = vi.hoisted(() => ({ emitSpy: vi.fn() }));
vi.mock('./activity-log.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, emit: emitSpy };
});

import { createScheduler, DEFAULT_INTERVAL_MS } from './index.js';
import type { SchedulerHooks } from './index.js';
import { beginParikshaka, endParikshaka } from './parikshaka-tracker.js';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

type PhaseEvent = { type: string; from: string; to: string; heldMs: number; polls?: number };
function phaseEvents(): PhaseEvent[] {
  return emitSpy.mock.calls.map((c: unknown[]) => c[0] as PhaseEvent).filter(e => e.type === 'phase_changed');
}
function phaseEdges(): string[] {
  return phaseEvents().map(e => `${e.from}->${e.to}`);
}

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

// Typed cycle outcome (epic 7h3 / Study B3): drain reads this to decide re-tick vs
// wait vs exit. The daemon ignores it, so these must not change any existing edge.
describe('runCycle outcome', () => {
  it("returns 'no-work' when selectNext yields null", async () => {
    const scheduler = createScheduler();
    expect(await scheduler.runCycle(KSHETRA, makeHooks())).toBe('no-work');
  });

  it("returns 'declined' when prepareTask rejects the pick (returns null)", async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      prepareTask: vi.fn().mockResolvedValue(null),
    });
    expect(await scheduler.runCycle(KSHETRA, hooks)).toBe('declined');
  });

  it("returns 'ran' when a task was dispatched to WORKING", async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    expect(await scheduler.runCycle(KSHETRA, hooks)).toBe('ran');
  });

  it("returns 'declined' when a cycle is already in flight (no re-tick spin)", async () => {
    const scheduler = createScheduler();
    let resolveTask!: () => void;
    const taskPromise = new Promise<void>(r => { resolveTask = r; });
    const hooks1 = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockReturnValue(taskPromise),
    });
    const cycle1 = scheduler.runCycle(KSHETRA, hooks1);
    await tick(); // WORKING

    const hooks2 = makeHooks({ selectNext: vi.fn().mockResolvedValue(P0_TASK) });
    expect(await scheduler.runCycle(KSHETRA, hooks2)).toBe('declined');

    resolveTask();
    await cycle1;
  });

  it('still propagates a runTask throw (does not resolve to an outcome)', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockRejectedValue(new Error('task failed')),
    });
    await expect(scheduler.runCycle(KSHETRA, hooks)).rejects.toThrow('task failed');
  });
});

// In-flight signal (epic 7h3 / Study B3): true while a task is dispatched OR a
// Parikshaka backfill is outstanding; false once BOTH settle.
describe('isInFlight', () => {
  it('is false before, true during, false after a task', async () => {
    const scheduler = createScheduler();
    let duringTask: boolean | undefined;
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      runTask: vi.fn().mockImplementation(async () => { duringTask = scheduler.isInFlight(KSHETRA.id); }),
    });
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(false);
    await scheduler.runCycle(KSHETRA, hooks);
    expect(duringTask).toBe(true);
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(false);
  });

  it('stays true while a Parikshaka backfill is outstanding, false once it settles', () => {
    const scheduler = createScheduler();
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(false);
    beginParikshaka(KSHETRA.id);
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(true);
    endParikshaka(KSHETRA.id);
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(false);
  });

  it('remains in-flight until BOTH a backfill and the count of backfills settle', () => {
    const scheduler = createScheduler();
    beginParikshaka(KSHETRA.id);
    beginParikshaka(KSHETRA.id); // two overlapping backfills
    endParikshaka(KSHETRA.id);
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(true); // one still outstanding
    endParikshaka(KSHETRA.id);
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(false);
  });

  it('is isolated per kshetra', () => {
    const scheduler = createScheduler();
    beginParikshaka(KSHETRA.id);
    expect(scheduler.isInFlight(KSHETRA.id)).toBe(true);
    expect(scheduler.isInFlight(KSHETRA_B.id)).toBe(false);
    endParikshaka(KSHETRA.id);
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

  // Immediate re-tick after a completed task (epic 7h3 / Study B3).
  it("re-ticks immediately on 'ran' — two ready beads claimed back-to-back, no interval gap", async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    // Two ready beads then nothing. runTask resolves at once, so each cycle 'ran'.
    const selectNext = vi.fn()
      .mockResolvedValueOnce(P2_TASK)
      .mockResolvedValueOnce({ ...P2_TASK, id: 'bd-003' })
      .mockResolvedValue(null);
    const hooks = makeHooks({ selectNext });

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    // One interval fires the first tick; its 'ran' outcome re-ticks at 0ms. Drain
    // the chained 0ms re-ticks with tiny epsilon steps: the second and third
    // selects land within ~2ms of the first — far under the 100ms interval, which
    // is the whole point (no per-bead interval gap). The third ('no-work') then
    // schedules a normal interval wait, so the chain stops at three.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(selectNext).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the pending interval wait, not a hot 0ms loop
    stop();
  });

  it("does NOT re-tick early on 'declined' — next tick lands one full interval later", async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      prepareTask: vi.fn().mockResolvedValue(null), // preflight/health rejected → 'declined'
    });

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(hooks.selectNext).toHaveBeenCalledTimes(1);
    // No early re-tick: nothing more until a full interval elapses.
    await vi.advanceTimersByTimeAsync(99);
    expect(hooks.selectNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.selectNext).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does NOT re-tick early on 'no-work' — keeps the full interval", async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks(); // selectNext → null → 'no-work'

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(hooks.selectNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(hooks.selectNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.selectNext).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a repeatedly-declining kshetra ticks at most once per interval (no hot loop)', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      prepareTask: vi.fn().mockResolvedValue(null), // always declined
    });

    const stop = scheduler.scheduleLoop(KSHETRA, hooks, 100);
    // Ten intervals elapse. If 'declined' re-ticked early the count would explode;
    // it must be one tick per interval (10, plus at most the boundary tick).
    await vi.advanceTimersByTimeAsync(1000);
    const calls = (hooks.selectNext as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(calls).toBeLessThanOrEqual(11);
    stop();
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
describe('phase_changed timing (epic hto / Study A3)', () => {
  beforeEach(() => emitSpy.mockClear());

  it('emits one phase_changed per transition of a completed cycle, each with heldMs', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(phaseEdges()).toEqual([
      'IDLE->SELECTING', 'SELECTING->PREPARING', 'PREPARING->WORKING', 'WORKING->IDLE',
    ]);
    for (const e of phaseEvents()) expect(e.heldMs).toEqual(expect.any(Number));
  });

  it('coalesces consecutive empty polls — emits nothing per poll, one summary when work appears', async () => {
    const scheduler = createScheduler();
    const empty = makeHooks(); // selectNext → null
    await scheduler.runCycle(KSHETRA, empty);
    await scheduler.runCycle(KSHETRA, empty);
    await scheduler.runCycle(KSHETRA, empty);
    // Three empty polls, zero events so far (all coalesced) — not ~6.
    expect(phaseEvents()).toHaveLength(0);

    const work = makeHooks({ selectNext: vi.fn().mockResolvedValue(P2_TASK) });
    await scheduler.runCycle(KSHETRA, work);
    const events = phaseEvents();
    // One coalesced idle summary (polls=3), then the real cycle's four transitions.
    expect(events[0]).toMatchObject({ from: 'IDLE', to: 'SELECTING', polls: 3 });
    expect(events[0].heldMs).toEqual(expect.any(Number));
    expect(phaseEdges().slice(1)).toEqual([
      'IDLE->SELECTING', 'SELECTING->PREPARING', 'PREPARING->WORKING', 'WORKING->IDLE',
    ]);
  });

  it('flushPhase emits the coalesced idle summary (shutdown path), recovering total idle', async () => {
    const scheduler = createScheduler();
    const empty = makeHooks();
    await scheduler.runCycle(KSHETRA, empty);
    await scheduler.runCycle(KSHETRA, empty);
    expect(phaseEvents()).toHaveLength(0); // still coalescing
    scheduler.flushPhase(KSHETRA.id);
    const events = phaseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: 'IDLE', to: 'SELECTING', polls: 2 });
    // Idempotent: a second flush emits nothing (accumulator cleared).
    scheduler.flushPhase(KSHETRA.id);
    expect(phaseEvents()).toHaveLength(1);
  });

  it('does not coalesce a prepare-rejected cycle — it did real prepare work', async () => {
    const scheduler = createScheduler();
    const hooks = makeHooks({
      selectNext: vi.fn().mockResolvedValue(P2_TASK),
      prepareTask: vi.fn().mockResolvedValue(null), // rejected in PREPARE
    });
    await scheduler.runCycle(KSHETRA, hooks);
    expect(phaseEdges()).toEqual(['IDLE->SELECTING', 'SELECTING->PREPARING', 'PREPARING->IDLE']);
  });
});
