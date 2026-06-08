import { loadRegistry } from '../kshetra/registry';
import { createScheduler } from '../sthapathi/index';
import { pickup } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError } from '../sthapathi/errors';
import { branchName } from '../sthapathi/branch';
import { isKshetraManuallyPaused } from '../kshetra/state';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';

const kshetras = loadRegistry();

if (kshetras.length === 0) {
  console.error('[shreni daemon] No kshetras registered. Run `shreni register` first.');
  process.exit(1);
}

const scheduler = createScheduler();

const hooks = {
  async pickNext(kshetra: KshetraConfig): Promise<Task | null> {
    if (isKshetraManuallyPaused(kshetra)) return null;
    return pickup(kshetra);
  },
  async runTask(task: Task, kshetra: KshetraConfig): Promise<void> {
    try {
      await runSilpiViharapalaLoop(kshetra, task, branchName(task));
    } catch (err) {
      await handleCycleError(kshetra, task, err as Error);
    }
  },
};

const stop = scheduler.start(kshetras, hooks);

process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  stop();
  process.exit(0);
});