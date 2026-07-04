import { loadRegistry } from '../kshetra/registry';
import { createScheduler } from '../sthapathi/index';
import { selectNext, prepareTask } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError, AgentAbortedError } from '../sthapathi/errors';
import { recoverKshetra, scheduleResume } from '../sthapathi/recover';
import { runWatchdogOnce } from '../sthapathi/watchdog';
import { branchName } from '../sthapathi/branch';
import { touchHeartbeat } from '../sthapathi/activity-log';
import { selfHeal, shouldSelfHeal, type ActiveRun, type PauseSnapshot } from '../sthapathi/self-heal';
import { clearStuckPauseOnRecover, isKshetraManuallyPaused, loadState, setPhase } from '../kshetra/state';
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

// Persist the phase so `shreni status` / Phalaka can show it cross-process. Entering
// a non-IDLE phase also refreshes the heartbeat immediately, so the watchdog's
// liveness window starts fresh at the moment work begins (rather than up to one
// heartbeat tick stale). See the watchdog design §3.1.
const scheduler = createScheduler({
  onPhase: (_id, phase) => {
    setPhase(kshetra!, phase);
    if (phase !== 'IDLE') touchHeartbeat(kshetra!.id);
  },
});

// Run one task through the Silpi↔Viharapala loop, funnelling any throw into the
// error handler. Shared by the scheduler's WORK phase and by resume (same loop,
// same error policy — resume just skips SELECT/PREPARE).
async function runTaskSafely(
  k: KshetraConfig,
  task: Task,
  branch: string,
  signal?: AbortSignal,
): Promise<{ approved: boolean; note: string }> {
  try {
    return await runSilpiViharapalaLoop(k, task, branch, signal);
  } catch (err) {
    // A self-heal abort is a SANCTIONED cancellation, not a cycle failure — the
    // resume watcher deliberately aborted this run and will RECOVER the bead in
    // recoverKshetra. Routing it through handleCycleError would flag the bead and
    // clean the branch out from under the recovery. Swallow it quietly.
    if (err instanceof AgentAbortedError) return { approved: false, note: 'aborted for self-heal' };
    await handleCycleError(k, task, err as Error);
    return { approved: false, note: 'cycle error (handled)' };
  }
}

// The single in-flight run's cancellation handle + a promise that resolves once
// it has fully unwound, plus a gate the self-heal holds while RECOVER runs so no
// poll cycle mutates the work tree underneath it.
let activeRun: ActiveRun | undefined;
let healing = false;

const hooks = {
  async selectNext(k: KshetraConfig): Promise<Task | null> {
    // While a self-heal is in flight, no cycle may proceed to PREPARE (which
    // checks out main / mutates the tree) and race recoverKshetra. selectNext is
    // read-only and runs first in the cycle, so returning null here idles the
    // cycle before any mutation.
    if (healing) return null;
    if (isKshetraManuallyPaused(k)) return null;
    return selectNext(k);
  },
  prepareTask,
  async runTask(task: Task, k: KshetraConfig): Promise<void> {
    // Publish a cancellation handle so the resume watcher can abort a hung run
    // and RECOVER in-process. `done` resolves in the finally, after the loop has
    // unwound and (via runCycle's own finally) phase has returned to IDLE.
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    activeRun = { controller, task, done };
    try {
      await runTaskSafely(k, task, branchName(task), controller.signal);
    } finally {
      activeRun = undefined;
      resolveDone();
    }
  },
};

// Assigned once startup recovery has finished and the poll loop is armed.
let stop: (() => void) | undefined;

const BEADS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function sync(): Promise<void> {
  try {
    await syncBeads(kshetra!);
    console.log(`[shreni worker:${kshetraId}] beads synced`);
  } catch (err) {
    console.error(`[shreni worker:${kshetraId}] beads sync failed:`, err);
  }
}

// Startup: (1) sync the local DB, (2) RECONCILE any drift left by a crash/restart
// (dirty tree, stale bead-* branches, orphaned in_progress beads) back to a clean
// IDLE, (3) RESUME any reopened WIP through the work loop — bypassing the pickup
// health gate — and only THEN (4) arm the poll loop. Resuming before the loop is
// armed is what keeps resume (which runs WORKING outside the scheduler's phase
// machine) from racing a poll tick that would check out main under it. See
// recover.ts / the Sthapathi workflow design §4.2–4.3.
async function startup(): Promise<void> {
  await sync();
  const resumable = await recoverKshetra(kshetra!);
  // RECOVER has just reconciled the drift a stuck pause escalated over, so a
  // leftover auto-escalated stuck pause is now stale — clear it, or the fresh
  // worker comes up paused and idle, flying the old banner.
  // A deliberate user pause is left intact.
  if (clearStuckPauseOnRecover(kshetra!)) {
    console.log(`[shreni worker:${kshetraId}] cleared stale stuck pause after recovery`);
  }
  console.log(`[shreni worker:${kshetraId}] recovery complete (${resumable.length} to resume)`);
  for (const task of resumable) {
    console.log(`[shreni worker:${kshetraId}] resuming WIP bead ${task.id} (bypassing health gate)`);
    await scheduleResume(kshetra!, task, runTaskSafely);
  }
  stop = scheduler.scheduleLoop(kshetra!, hooks);
}

startup().catch(err => {
  console.error(`[shreni worker:${kshetraId}] startup failed:`, err);
  // Arm the poll loop anyway so a recovery/resume hiccup doesn't leave the worker
  // permanently idle — the normal gated pickup path is the safe fallback.
  stop ??= scheduler.scheduleLoop(kshetra!, hooks);
});

const syncTimer = setInterval(
  () => sync().catch(err => console.error(`[shreni worker:${kshetraId}] beads sync failed:`, err)),
  BEADS_SYNC_INTERVAL_MS,
);

// Watchdog: detect a stuck worker (hung agent or a repeating stall loop) and
// escalate — pause for manual resume + push an operator notification with
// remediation. Runs every minute; thresholds in watchdog.ts.
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const watchdogTimer = setInterval(() => {
  // hasReadyWork: probe the RAW ready queue (pickup's selectNext, not the
  // pause-gated hook) so the watchdog can tell "idle, nothing to do" from "hung"
  // and never escalate an empty-queue Kshetra to Phalaka.
  runWatchdogOnce(kshetra!, () => scheduler.getPhase(kshetra!.id), Date.now(), {
    hasReadyWork: async () => (await selectNext(kshetra!)) !== null,
  }).catch((err: unknown) => console.error(`[shreni worker:${kshetraId}] watchdog failed:`, err));
}, WATCHDOG_INTERVAL_MS);

// Worker-liveness heartbeat (the watchdog design §3.1, fixes RC1): while a phase
// is active, stamp the heartbeat on a fixed cadence regardless of whether the agent
// has emitted anything. This is what makes a long SILENT tool call (build, test run,
// slow bd op) stop reading as a hung agent. Faster than the 20m stuck threshold so a
// real worker-event-loop wedge still goes stale and trips.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const heartbeatTimer = setInterval(() => {
  if (scheduler.getPhase(kshetra!.id) !== 'IDLE') touchHeartbeat(kshetra!.id);
}, HEARTBEAT_INTERVAL_MS);

// Resume watcher: `shreni resume` runs in a SEPARATE process
// and can only flip state.json — it cannot reach into this worker to cancel the
// hung agent. So we poll for the stuck-paused -> resumed transition and, when we
// see it with a run still in flight, self-heal in-process: abort the hung agent,
// RECOVER, and re-arm. Faster than the 60s watchdog so recovery lands promptly,
// and it holds the `healing` gate so RECOVER never races a poll cycle.
const RESUME_WATCH_INTERVAL_MS = 5 * 1000;
let prevPause: PauseSnapshot | undefined;
const resumeWatchTimer = setInterval(() => {
  const curr = loadState().kshetras[kshetra!.id] as PauseSnapshot | undefined;
  if (shouldSelfHeal(prevPause, curr, activeRun !== undefined, healing)) {
    const run = activeRun!;
    healing = true;
    console.log(`[shreni worker:${kshetraId}] stuck resume detected — self-healing bead ${run.task.id}`);
    selfHeal(kshetra!, run)
      .then(() => console.log(`[shreni worker:${kshetraId}] self-heal complete — back to IDLE`))
      .catch((err: unknown) => console.error(`[shreni worker:${kshetraId}] self-heal failed:`, err))
      .finally(() => { healing = false; });
  }
  prevPause = curr;
}, RESUME_WATCH_INTERVAL_MS);

function shutdown(): void {
  stop?.();
  clearInterval(syncTimer);
  clearInterval(watchdogTimer);
  clearInterval(heartbeatTimer);
  clearInterval(resumeWatchTimer);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
