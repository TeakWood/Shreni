import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { recordProgress as defaultRecordProgress } from '../kshetra/state.js';
import { touchHeartbeat as defaultTouchHeartbeat } from './activity-log.js';
import { recoverKshetra as defaultRecover } from './recover.js';

// A handle to the worker's single in-flight run, so a cross-process resume can
// cancel it and drive an in-process RECOVER. `done` resolves
// when the run has fully unwound (the scheduler's WORK cycle has returned and
// set phase back to IDLE), which self-heal must await BEFORE reconciling git.
export interface ActiveRun {
  controller: AbortController;
  task: Task;
  done: Promise<void>;
}

// Snapshot of the pause fields self-heal watches, read from state.json.
export interface PauseSnapshot {
  paused?: boolean;
  reason?: string;
}

function isStuckPaused(s: PauseSnapshot | undefined): boolean {
  return !!(s?.paused && s.reason === 'stuck');
}

// Edge detector: fire self-heal only on a stuck-paused -> resumed TRANSITION,
// and only when there is an in-flight run to cancel and we are not already
// healing. Entering the stuck state (prev not stuck, curr stuck) must NOT fire;
// a resume with no active run is a plain state clear with nothing to recover.
export function shouldSelfHeal(
  prev: PauseSnapshot | undefined,
  curr: PauseSnapshot | undefined,
  hasActiveRun: boolean,
  healing: boolean,
): boolean {
  return isStuckPaused(prev) && !isStuckPaused(curr) && hasActiveRun && !healing;
}

export interface SelfHealDeps {
  recover?: (kshetra: KshetraConfig) => Promise<Task[]>;
  recordProgress?: (kshetra: KshetraConfig) => void;
  touchHeartbeat?: (kshetraId: string) => void;
}

// In-process recovery of a hung (reason:'stuck') worker after `shreni resume`
// cleared its pause. Ordering is load-bearing:
//   1. refresh liveness FIRST (heartbeat file mtime + clear the stall counters)
//      so the watchdog can't re-trip mid-heal;
//   2. abort the hung provider subprocess (SIGKILL via the run's signal);
//   3. await the run fully unwinding — the scheduler's WORK cycle returns and
//      resets phase to IDLE, and its single-flight latch clears;
//   4. RECOVER reconciles the four drifting truths (tree, branches, bead status,
//      phase) and reopens the bead for a fresh, gated pickup;
//   5. refresh liveness once more post-recover.
// recordProgress stamps state.json (clears outcomeRepeatCount so the stall branch
// can't re-trip); touchHeartbeat bumps the separate heartbeat FILE the watchdog
// actually reads for liveness — both are needed. The caller MUST hold a `healing`
// gate around this that makes selectNext return null, so no poll cycle can mutate
// the work tree (prepareTask / checkout main) while RECOVER is running — the loop
// is already armed here, unlike startup.
export async function selfHeal(
  kshetra: KshetraConfig,
  run: ActiveRun,
  deps: SelfHealDeps = {},
): Promise<void> {
  const recover = deps.recover ?? defaultRecover;
  const recordProgress = deps.recordProgress ?? defaultRecordProgress;
  const touchHeartbeat = deps.touchHeartbeat ?? defaultTouchHeartbeat;

  recordProgress(kshetra);        // 1
  touchHeartbeat(kshetra.id);
  run.controller.abort();         // 2
  await run.done;                 // 3
  await recover(kshetra);         // 4
  recordProgress(kshetra);        // 5
  touchHeartbeat(kshetra.id);
}
