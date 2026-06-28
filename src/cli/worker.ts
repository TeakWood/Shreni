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

// A worker process drives exactly one kshetra. Its id is passed as argv[2] by
// `shreni start`. Each worker has its own PID + logs under ~/.shreni/kshetra/<id>/,
// so one kshetra crashing never takes the others down.

const kshetraId = process.argv[2];

if (!kshetraId) {
  console.error('[shreni worker] missing kshetra id argument');
  process.exit(1);
}

const kshetra = loadRegistry().find(k => k.id === kshetraId);

if (!kshetra) {
  console.error(`[shreni worker] kshetra not registered: ${kshetraId}`);
  process.exit(1);
}

const scheduler = createScheduler();

const hooks = {
  async pickNext(k: KshetraConfig): Promise<Task | null> {
    if (isKshetraManuallyPaused(k)) return null;
    return pickup(k);
  },
  async runTask(task: Task, k: KshetraConfig): Promise<void> {
    try {
      await runSilpiViharapalaLoop(k, task, branchName(task));
    } catch (err) {
      await handleCycleError(k, task, err as Error);
    }
  },
};

const stop = scheduler.scheduleLoop(kshetra, hooks);

const BEADS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function sync(): Promise<void> {
  try {
    await syncBeads(kshetra!);
    console.log(`[shreni worker:${kshetraId}] beads synced`);
  } catch (err) {
    console.error(`[shreni worker:${kshetraId}] beads sync failed:`, err);
  }
}

// Sync on startup so the local DB is up to date before the first task poll
sync().catch(err => console.error(`[shreni worker:${kshetraId}] initial beads sync failed:`, err));

const syncTimer = setInterval(
  () => sync().catch(err => console.error(`[shreni worker:${kshetraId}] beads sync failed:`, err)),
  BEADS_SYNC_INTERVAL_MS,
);

function shutdown(): void {
  stop();
  clearInterval(syncTimer);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
