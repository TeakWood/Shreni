import { spawn } from 'child_process';
import { resolve } from 'path';
import { openSync, mkdirSync } from 'fs';
import { readPid, writePid, isAlive, kshetraDir, workerLogPath } from './pid';

export type StartResult =
  | { status: 'started'; kshetraId: string; pid: number }
  | { status: 'already_running'; kshetraId: string; pid: number };

export function startWorker(
  kshetraId: string,
  workerScript: string = resolve(__dirname, 'worker.js'),
): StartResult {
  const existing = readPid(kshetraId);
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', kshetraId, pid: existing };
  }

  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  const logFd = openSync(workerLogPath(kshetraId), 'a');
  const child = spawn(process.execPath, [workerScript, kshetraId], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  if (child.pid === undefined) {
    throw new Error(`Failed to spawn worker process for "${kshetraId}"`);
  }

  writePid(kshetraId, child.pid);
  child.unref();

  return { status: 'started', kshetraId, pid: child.pid };
}
