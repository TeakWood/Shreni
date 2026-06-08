import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

export interface SchedulerHooks {
  pickNext(kshetra: KshetraConfig): Promise<Task | null>;
  runTask(task: Task, kshetra: KshetraConfig): Promise<void>;
}

export interface Scheduler {
  runCycle(kshetra: KshetraConfig, hooks: SchedulerHooks): Promise<void>;
  scheduleLoop(kshetra: KshetraConfig, hooks: SchedulerHooks, intervalMs?: number): () => void;
  start(kshetras: KshetraConfig[], hooks: SchedulerHooks, intervalMs?: number): () => void;
  getActive(kshetraId: string): Task | undefined;
}

export const DEFAULT_INTERVAL_MS = 30_000;

export function createScheduler(): Scheduler {
  const active = new Map<string, Task>();

  async function runCycle(kshetra: KshetraConfig, hooks: SchedulerHooks): Promise<void> {
    const current = active.get(kshetra.id);

    const task = await hooks.pickNext(kshetra);
    if (!task) return;

    // P0 preempts an active non-P0 task; otherwise skip if at capacity
    const p0Preempts = task.priority === 0 && current !== undefined && current.priority > 0;
    if (current !== undefined && !p0Preempts) return;

    active.set(kshetra.id, task);
    try {
      await hooks.runTask(task, kshetra);
    } finally {
      // Guard against a concurrent preemption having already replaced this task
      if (active.get(kshetra.id) === task) {
        active.delete(kshetra.id);
      }
    }
  }

  function scheduleLoop(
    kshetra: KshetraConfig,
    hooks: SchedulerHooks,
    intervalMs = DEFAULT_INTERVAL_MS,
  ): () => void {
    const tick = () => {
      runCycle(kshetra, hooks).catch((err: unknown) => {
        console.error(`[sthapathi] cycle error for "${kshetra.id}":`, err);
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

  return { runCycle, scheduleLoop, start, getActive };
}