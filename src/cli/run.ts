import { loadRegistry } from '../kshetra/registry';
import { isKshetraManuallyPaused } from '../kshetra/state';
import { createScheduler, type SchedulerHooks } from '../sthapathi/index';
import { selectNext, prepareTask } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError } from '../sthapathi/errors';
import { branchName } from '../sthapathi/branch';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';

export async function runManualCycle(kshetraId: string): Promise<void> {
  const kshetra = loadRegistry().find((k: KshetraConfig) => k.id === kshetraId);
  if (!kshetra) throw new Error(`Kshetra not found: ${kshetraId}`);

  const scheduler = createScheduler();

  const hooks: SchedulerHooks = {
    async selectNext(k: KshetraConfig): Promise<Task | null> {
      if (isKshetraManuallyPaused(k)) return null;
      return selectNext(k);
    },
    prepareTask,
    async runTask(task: Task, k: KshetraConfig): Promise<void> {
      try {
        await runSilpiViharapalaLoop(k, task, branchName(task));
      } catch (err) {
        await handleCycleError(k, task, err as Error);
      }
    },
  };

  await scheduler.runCycle(kshetra, hooks);
}

export async function runRun(kshetraId: string): Promise<void> {
  console.log(`Running immediate cycle for kshetra "${kshetraId}"...`);
  await runManualCycle(kshetraId);
  console.log('Cycle complete.');
}