import { spawn } from 'child_process';
import { resolve } from 'path';
import { readPid, writePid, isAlive } from './pid';

export type StartResult =
  | { status: 'started'; pid: number }
  | { status: 'already_running'; pid: number };

export function startDaemon(
  daemonScript: string = resolve(__dirname, 'daemon.js'),
): StartResult {
  const existing = readPid();
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', pid: existing };
  }

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore',
  });

  if (child.pid === undefined) {
    throw new Error('Failed to spawn daemon process');
  }

  writePid(child.pid);
  child.unref();

  return { status: 'started', pid: child.pid };
}