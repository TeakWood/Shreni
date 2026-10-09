import type { Task } from './types.js';

// A handle to the worker's single in-flight run, so a cross-process resume can
// cancel it and reset the work tree in-process. `done` resolves
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
