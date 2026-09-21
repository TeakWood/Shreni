import { loadRegistry } from '../kshetra/registry';
import { createWorkerRuntime, workerPreconditionError } from './worker-runtime';
import { parseLabels } from './labels';

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
let stop: (() => void) | undefined;
let stopTimers: (() => void) | undefined;

// Startup: sync + RECOVER crash drift + RESUME reopened WIP, and only THEN arm
// the poll loop — resuming before the loop is armed keeps resume (which runs
// WORKING outside the scheduler's phase machine) from racing a poll tick.
runtime.startup()
  .then(() => {
    stop = runtime.scheduler.scheduleLoop(runtime.kshetra, runtime.hooks);
  })
  .catch(err => {
    console.error(`[shreni worker:${kshetraId}] startup failed:`, err);
    // Arm the poll loop anyway so a recovery/resume hiccup doesn't leave the
    // worker permanently idle — the normal gated pickup path is the safe fallback.
    stop ??= runtime.scheduler.scheduleLoop(runtime.kshetra, runtime.hooks);
  });

// The background timers (bead sync, PR reconcile, watchdog, heartbeat, resume
// watcher) run independently of startup — arm them immediately.
stopTimers = runtime.startTimers();

function shutdown(): void {
  stop?.();
  stopTimers?.();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
