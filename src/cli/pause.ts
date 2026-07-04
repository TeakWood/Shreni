import { loadRegistry } from '../kshetra/registry';
import { loadState, pauseKshetra, resumeKshetra } from '../kshetra/state';
import { readPid, isAlive } from './pid';

export type PauseResult =
  | { status: 'paused'; id: string }
  | { status: 'not_found'; id: string };

export type ResumeResult =
  // normal (api_down/git_failed/bd_failed/manual) pause cleared
  | { status: 'resumed'; id: string }
  // reason:'stuck' pause cleared while its worker is alive — the worker's resume
  // watcher will abort the hung agent and RECOVER in-process (Shreni-beads-se0)
  | { status: 'resumed_self_heal'; id: string }
  // reason:'stuck' pause cleared but no worker is running to self-heal — the
  // pause is gone, but the bead recovers on the next `shreni start` (startup
  // RECOVER + clearStuckPauseOnRecover)
  | { status: 'resumed_needs_start'; id: string; hint: string }
  | { status: 'not_found'; id: string };

export function pauseKshetraById(id: string): PauseResult {
  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) return { status: 'not_found', id };

  pauseKshetra(kshetra, {
    manual: true,
    reason: 'manual',
    message: 'Paused via CLI',
  });
  return { status: 'paused', id };
}

export function resumeKshetraById(id: string): ResumeResult {
  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) return { status: 'not_found', id };

  // A reason:'stuck' pause means a live worker's watchdog tripped on a hung
  // agent. Clearing the pause is now MEANINGFUL: the running worker watches for
  // this transition and self-heals in-process — aborts the hung agent, RECOVERs,
  // and re-arms (Shreni-beads-se0, which supersedes the interim refuse-guard
  // -x4e). We still clear the pause the same way; the only branch is the message
  // we hand back, keyed on whether a worker is actually alive to do the heal.
  const wasStuck = loadState().kshetras[id]?.reason === 'stuck';
  resumeKshetra(kshetra);

  if (wasStuck) {
    const pid = readPid(id);
    const workerAlive = pid !== null && isAlive(pid);
    if (workerAlive) return { status: 'resumed_self_heal', id };
    // No worker to observe the resume — the pause is cleared, but the bead only
    // gets reconciled when a worker next starts.
    return { status: 'resumed_needs_start', id, hint: `shreni start --kshetra ${id}` };
  }

  return { status: 'resumed', id };
}