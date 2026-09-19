import { loadRegistry } from '../kshetra/registry';
import { isKshetraManuallyPaused } from '../kshetra/state';
import { createScheduler, type SchedulerHooks } from '../sthapathi/index';
import { selectNext, prepareTask } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError } from '../sthapathi/errors';
import { branchName } from '../sthapathi/branch';
import { selectFollowup } from '../sthapathi/pr-followup';
import { runPrFollowupTask } from '../sthapathi/pr-followup-run';
import { emitLotManifest } from '../sthapathi/activity-log';
import { getBuildIdentity } from '../sthapathi/build-info';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';

export async function runManualCycle(kshetraId: string): Promise<void> {
  const kshetra = loadRegistry().find((k: KshetraConfig) => k.id === kshetraId);
  if (!kshetra) throw new Error(`Kshetra not found: ${kshetraId}`);

  // Emit the lot manifest (epic yrk / Study B2) at the start of the manual cycle,
  // so every event this cycle emits carries the lot's id. The manual-cycle path
  // registers no ledger sink (consistent with `shreni run` not writing the ledger),
  // so this lands in activity.jsonl only. process.shreni is the build identity
  // (yrk.2); yrk.3 adds the remaining subject/process fields regardless of sink.
  emitLotManifest(kshetraId, 'run', {}, { process: { shreni: getBuildIdentity() } });

  const scheduler = createScheduler();

  const hooks: SchedulerHooks = {
    async selectNext(k: KshetraConfig): Promise<Task | null> {
      if (isKshetraManuallyPaused(k)) return null;
      const followup = await selectFollowup(k);
      if (followup) return followup;
      return selectNext(k);
    },
    prepareTask,
    async runTask(task: Task, k: KshetraConfig): Promise<void> {
      try {
        if (task.followup) await runPrFollowupTask(k, task);
        else await runSilpiViharapalaLoop(k, task, branchName(task));
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