import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { openSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { readPid, writePid, isAlive } from './pid';

export const DAEMON_LOG_PATH = resolve(homedir(), '.shreni', 'daemon.log');

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

  mkdirSync(dirname(DAEMON_LOG_PATH), { recursive: true });
  const logFd = openSync(DAEMON_LOG_PATH, 'a');
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  if (child.pid === undefined) {
    throw new Error('Failed to spawn daemon process');
  }

  writePid(child.pid);
  child.unref();

  return { status: 'started', pid: child.pid };
}