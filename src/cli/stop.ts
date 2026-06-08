import { readPid, clearPid, isAlive } from './pid';

export type StopResult =
  | { status: 'stopped'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale_pid_cleared' };

export function stopDaemon(): StopResult {
  const pid = readPid();

  if (pid === null) {
    return { status: 'not_running' };
  }

  if (!isAlive(pid)) {
    clearPid();
    return { status: 'stale_pid_cleared' };
  }

  process.kill(pid, 'SIGTERM');
  clearPid();
  return { status: 'stopped', pid };
}