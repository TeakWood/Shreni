import { describe, it, expect, vi } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from './types';
import { shouldSelfHeal, type ActiveRun, type PauseSnapshot } from './self-heal';
import { createScheduler, type Phase } from './index';
import { evaluateStuck } from './watchdog';
import { AgentAbortedError } from './errors';

const KSHETRA = { id: 'myapp', name: 'Myapp' } as unknown as KshetraConfig;
const TASK: Task = { id: 'bd-1', slug: 'fix-login', title: 'Fix login', status: 'in_progress', priority: 2, round: 1 };

const STUCK: PauseSnapshot = { paused: true, reason: 'stuck' };
const RESUMED: PauseSnapshot = { paused: false, reason: 'stuck' };
const MANUAL: PauseSnapshot = { paused: true, reason: 'manual' };

function makeRun(): ActiveRun & { resolveDone: () => void } {
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>(r => { resolveDone = r; });
  return { controller, task: TASK, done, resolveDone };
}

// ── shouldSelfHeal (pure edge detector) ───────────────────────────────────────

describe('shouldSelfHeal', () => {
  it('fires on a stuck-paused -> resumed transition with an active run', () => {
    expect(shouldSelfHeal(STUCK, RESUMED, true, false)).toBe(true);
  });

  it('fires when the resume clears the pause entry entirely (curr undefined)', () => {
    expect(shouldSelfHeal(STUCK, undefined, true, false)).toBe(true);
  });

  it('does NOT fire when merely ENTERING the stuck state', () => {
    expect(shouldSelfHeal(undefined, STUCK, true, false)).toBe(false);
    expect(shouldSelfHeal(MANUAL, STUCK, true, false)).toBe(false);
  });

  it('does NOT fire while still stuck-paused (no transition)', () => {
    expect(shouldSelfHeal(STUCK, STUCK, true, false)).toBe(false);
  });

  it('does NOT fire without an in-flight run to cancel', () => {
    expect(shouldSelfHeal(STUCK, RESUMED, false, false)).toBe(false);
  });

  it('does NOT fire while already healing (re-entrancy guard)', () => {
    expect(shouldSelfHeal(STUCK, RESUMED, true, true)).toBe(false);
  });

  it('does NOT fire for a non-stuck pause transition (manual resume)', () => {
    expect(shouldSelfHeal(MANUAL, { paused: false }, true, false)).toBe(false);
  });
});

// ── acceptance: a stuck live worker returns to IDLE on resume, no re-trip ──────

describe('self-heal end-to-end (scheduler)', () => {
  it('drives a hung WORKING cycle back to IDLE via abort + work-tree reset, and does not re-trip', async () => {
    const scheduler = createScheduler();
    let activeRun: ActiveRun | undefined;
    let selected = false;

    // Mirror the worker's runTask wiring: publish a cancel handle, run an
    // abortable "hung agent", swallow the sanctioned abort (as runTaskSafely does).
    const hooks = {
      async selectNext(): Promise<Task | null> {
        return selected ? null : ((selected = true), TASK);
      },
      async prepareTask(t: Task): Promise<Task | null> { return t; },
      async runTask(t: Task): Promise<void> {
        const controller = new AbortController();
        let resolveDone!: () => void;
        const done = new Promise<void>(r => { resolveDone = r; });
        activeRun = { controller, task: t, done };
        try {
          await new Promise<void>((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new AgentAbortedError()),
              { once: true },
            );
          });
        } catch (err) {
          if (!(err instanceof AgentAbortedError)) throw err;
          // swallowed — the work tree is reset and the claim given back
        } finally {
          activeRun = undefined;
          resolveDone();
        }
      },
    };

    // Kick the cycle; it parks in WORKING on the hung agent.
    const cycle = scheduler.runCycle(KSHETRA, hooks);
    await vi.waitFor(() => expect(scheduler.getPhase(KSHETRA.id)).toBe('WORKING'));
    expect(activeRun).toBeDefined();

    // Simulate `shreni resume`: the worker's watcher aborts the run, awaits its
    // unwind, then resets the work tree (the claim is given back by the run's end).
    const recover = vi.fn(async (_k: KshetraConfig) => {});
    const run = activeRun!;
    run.controller.abort(new AgentAbortedError('self-heal'));
    await Promise.all([run.done.then(() => recover(KSHETRA)), cycle]);

    expect(recover).toHaveBeenCalledWith(KSHETRA);
    expect(scheduler.getPhase(KSHETRA.id)).toBe('IDLE');

    // The watchdog, evaluated now (phase IDLE, heartbeat freshly stamped), must
    // NOT re-trip — the failure mode se0 fixes.
    const verdict = evaluateStuck({
      phase: scheduler.getPhase(KSHETRA.id) as Phase,
      manuallyPaused: false,
      heartbeatAgeMs: 0,
      outcomeRepeatCount: 0,
    });
    expect(verdict.stuck).toBe(false);
  });
});
