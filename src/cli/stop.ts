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
  clearPid(kshetraId);
  return { status: 'stopped', kshetraId, pid };
}
