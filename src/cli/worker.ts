import { loadRegistry } from '../kshetra/registry';
import { createWorkerRuntime, workerPreconditionError } from './worker-runtime';
import { WorkerLockHeld } from '../policy/sthapathi/leases';
import { parseLabels } from './labels';
import { claimForThisProcess } from './pid';

// A worker process drives exactly one kshetra. Its id is passed as argv[2] by
// `shreni start`. Each worker has its own PID + logs under ~/.shreni/kshetra/<id>/,
// so one kshetra crashing never takes the others down.
//
// The real machinery (scheduler, hooks, self-heal, startup, the background timers)
// lives in worker-runtime.ts, shared verbatim with `shreni drain` (epic 7h3). This
// entry owns only what is specific to the long-lived daemon: reading argv, the
// precondition gate (log + exit 1), arming the poll loop (scheduleLoop, which
// never exits), and clean shutdown on a signal.

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

// Ownership (Shreni-beads-4w0): `shreni start` already claimed worker.pid for
// this pid; claiming again is a no-op then, and is what refuses a directly-invoked
// __worker on a kshetra a live drain or daemon already owns. Claimed BEFORE the
// precondition gate so its 'exit' backstop releases the pid on any early exit
// below — no dead worker row left behind by a child that never ran.
let releaseOwnership: () => void;
try {
  releaseOwnership = claimForThisProcess(kshetraId);
} catch (err) {
  console.error(`[shreni worker:${kshetraId}] ${(err as Error).message}`);
  process.exit(1);
}

// Opaque run labels (epic yrk / Study B2), threaded from `shreni start` as
// `--label key=value` args after the kshetra id. Already shape-validated by the
// `start` command; re-parsed here so they reach the lot manifest.
const labels = parseLabels(process.argv.slice(3));

// Ablation guard (epic 8wi) + credential preflight (b0f.3): `shreni start`
// already ran these, but __worker can be invoked directly — gate defensively so a
// copied config can never silently weaken a real repo, and a missing key fails
// loud here rather than mid-run.
const allowAblation = process.argv.includes('--allow-ablation');
const precondErr = workerPreconditionError(kshetra, allowAblation);
if (precondErr) {
  console.error(`[shreni worker:${kshetraId}] ${precondErr}`);
  process.exit(1);
}

const runtime = createWorkerRuntime(kshetra, { labels, allowAblation, entrypoint: 'worker' });

// Assigned once startup recovery has finished and the poll loop is armed.
let stop: ReturnType<typeof runtime.scheduler.scheduleLoop> | undefined;
// Others' writes that may make work ready wake the loop between polls; one
// during startup is kept for the loop once it is armed.
let wokeEarly = false;
runtime.onWake(() => { if (stop) stop.wake(); else wokeEarly = true; });
let stopTimers: (() => void) | undefined;

// Startup: open the engine (taking the worker lock), reset the work tree and
// reconcile PRs, and only THEN arm the poll loop.
runtime.startup()
  .then(() => {
    stop = runtime.scheduler.scheduleLoop(runtime.kshetra, runtime.hooks);
    if (wokeEarly) stop.wake();
  })
  .catch(err => {
    console.error(`[shreni worker:${kshetraId}] startup failed:`, err);
    // Another worker already runs this Kshetra (possibly on another machine):
    // refuse to start rather than arm a loop that would pick up nothing.
    if (err instanceof WorkerLockHeld) {
      releaseOwnership();
      process.exit(1);
    }
    // Arm the poll loop anyway so a startup hiccup doesn't leave the
    // worker permanently idle — the normal gated pickup path is the safe fallback.
    stop ??= runtime.scheduler.scheduleLoop(runtime.kshetra, runtime.hooks);
  });

// The background timers (PR reconcile, watchdog, heartbeat, resume
// watcher) run independently of startup — arm them immediately.
stopTimers = runtime.startTimers();

function shutdown(): void {
  stop?.();
  stopTimers?.();
  // Close the engine's connections (dropping the worker lock) before giving up
  // the pid file, so a restart never finds this worker's lock still held. If
  // closing hangs, the exit drops the connections anyway.
  const exit = () => { releaseOwnership(); process.exit(0); };
  void runtime.close().catch(() => {}).finally(exit);
  setTimeout(exit, 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
