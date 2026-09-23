import { readPid, clearPid, isAlive } from './pid';

export type StopResult =
  | { status: 'stopped'; kshetraId: string; pid: number }
  | { status: 'not_running'; kshetraId: string }
  | { status: 'stale_pid_cleared'; kshetraId: string };

export function stopWorker(kshetraId: string): StopResult {
  const pid = readPid(kshetraId);

  if (pid === null) {
    return { status: 'not_running', kshetraId };
  }

  if (!isAlive(pid)) {
    clearPid(kshetraId);
    return { status: 'stale_pid_cleared', kshetraId };
  }

  process.kill(pid, 'SIGTERM');
  // Do NOT clear worker.pid here (Shreni-beads-4w0): the owner releases its own
  // claim when it actually exits. A drain handles SIGTERM by finishing its
  // in-flight cycle first, so clearing now would leave the kshetra unowned while
  // that drain is still working the tree — letting a second worker start on it.
  // A worker that dies without releasing leaves a dead pid, which is stale and
  // reclaimable by the next claim.
  return { status: 'stopped', kshetraId, pid };
}
