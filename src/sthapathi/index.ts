import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// Worker lifecycle phase. One task at a time is enforced structurally: a cycle
// only starts from IDLE (see runCycle). See the Sthapathi workflow design §4.1.
export type Phase = 'IDLE' | 'SELECTING' | 'PREPARING' | 'WORKING';

export interface SchedulerHooks {
  // SELECT — read-only: choose the next ready task. Must NOT mutate the work tree.
  selectNext(kshetra: KshetraConfig): Promise<Task | null>;
  // PREPARE — the only mutator: claim + set up the work tree. Returns the task to
  // work, or null if it was rejected (preflight/health) and the cycle should idle.
  prepareTask(task: Task, kshetra: KshetraConfig): Promise<Task | null>;
  // WORK — run the agent loop for the prepared task.
  runTask(task: Task, kshetra: KshetraConfig): Promise<void>;
}

export interface Scheduler {
  runCycle(kshetra: KshetraConfig, hooks: SchedulerHooks): Promise<void>;
  scheduleLoop(kshetra: KshetraConfig, hooks: SchedulerHooks, intervalMs?: number): () => void;
  start(kshetras: KshetraConfig[], hooks: SchedulerHooks, intervalMs?: number): () => void;
  getActive(kshetraId: string): Task | undefined;
  getPhase(kshetraId: string): Phase;
}

export const DEFAULT_INTERVAL_MS = 30_000;

export function createScheduler(opts: { onPhase?: (kshetraId: string, phase: Phase) => void } = {}): Scheduler {
  const active = new Map<string, Task>();
  const phase = new Map<string, Phase>();

  function getPhase(kshetraId: string): Phase {
    return phase.get(kshetraId) ?? 'IDLE';
  }

  // Set the in-memory phase and notify the optional observer (the worker persists
  // it to state.json so `shreni status` / Phalaka can show it cross-process).
  function setPhase(kshetraId: string, p: Phase): void {
    phase.set(kshetraId, p);
    opts.onPhase?.(kshetraId, p);
  }

  // One task at a time is a STRUCTURAL invariant, not an emergent property of
  // several guards: a cycle runs only from IDLE, and the phase is advanced
  // SYNCHRONOUSLY (before the first await) so an overlapping tick for the same
  // Kshetra is an immediate no-op. Crucially, SELECT (read-only) is separated
  // from PREPARE (the only work-tree mutation), so polling for work can never
  // check out main under an in-flight agent — the cause of the off-branch aborts
  //. See the Sthapathi workflow design §4.1–4.2.
  async function runCycle(kshetra: KshetraConfig, hooks: SchedulerHooks): Promise<void> {
    if (getPhase(kshetra.id) !== 'IDLE') return;
    setPhase(kshetra.id, 'SELECTING');
    try {
      const selected = await hooks.selectNext(kshetra);
      if (!selected) return;

      setPhase(kshetra.id, 'PREPARING');
      const prepared = await hooks.prepareTask(selected, kshetra);
      if (!prepared) return;

      setPhase(kshetra.id, 'WORKING');
      active.set(kshetra.id, prepared);
      await hooks.runTask(prepared, kshetra);
    } finally {
      active.delete(kshetra.id);
      setPhase(kshetra.id, 'IDLE');
    }
  }

  function scheduleLoop(
    kshetra: KshetraConfig,
    hooks: SchedulerHooks,
    intervalMs = DEFAULT_INTERVAL_MS,
  ): () => void {
    // Single-flight: skip a tick while the previous cycle is still running.
    // runCycle calls pickNext (= pickup → preFlightCheck → `git checkout main`)
    // before its capacity check, so overlapping cycles would check out main
    // under an in-flight agent and knock it off its bead branch. Holding the
    // tick until the active runTask resolves keeps pickup off the work repo
    // while an agent is working (P0 preemption is deferred to idle).
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      runCycle(kshetra, hooks)
        .catch((err: unknown) => {
          console.error(`[sthapathi] cycle error for "${kshetra.id}":`, err);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }

  function start(
    kshetras: KshetraConfig[],
    hooks: SchedulerHooks,
    intervalMs = DEFAULT_INTERVAL_MS,
  ): () => void {
    const stops = kshetras.map(k => scheduleLoop(k, hooks, intervalMs));
    return () => stops.forEach(s => s());
  }

  function getActive(kshetraId: string): Task | undefined {
    return active.get(kshetraId);
  }

  return { runCycle, scheduleLoop, start, getActive, getPhase };
}