import { loadRegistry } from '../kshetra/registry';
import { createScheduler } from '../sthapathi/index';
import { pickup } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError } from '../sthapathi/errors';
import { branchName } from '../sthapathi/branch';
import { isKshetraManuallyPaused } from '../kshetra/state';
import { syncBeads } from '../sthapathi/beads';
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

const BEADS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function syncAll(): Promise<void> {
  for (const kshetra of kshetras) {
    try {
      await syncBeads(kshetra);
      console.log(`[shreni daemon] beads synced: ${kshetra.id}`);
    } catch (err) {
      console.error(`[shreni daemon] beads sync failed for "${kshetra.id}":`, err);
    }
  }
}

// Sync on startup so the local DB is up to date before the first task poll
syncAll().catch(err => console.error('[shreni daemon] initial beads sync failed:', err));

const syncTimer = setInterval(
  () => syncAll().catch(err => console.error('[shreni daemon] beads sync failed:', err)),
  BEADS_SYNC_INTERVAL_MS,
);

process.on('SIGTERM', () => {
  stop();
  clearInterval(syncTimer);
  process.exit(0);
});

process.on('SIGINT', () => {
  stop();
  clearInterval(syncTimer);
  process.exit(0);
});