import { spawn } from 'child_process';
import { openSync, mkdirSync } from 'fs';
import { readPid, writePid, isAlive, kshetraDir, workerLogPath } from './pid';
import { selfExec, type Launch } from './self-exec';

export type StartResult =
  | { status: 'started'; kshetraId: string; pid: number }
  | { status: 'already_running'; kshetraId: string; pid: number };

export function startWorker(
  kshetraId: string,
  // Defaults to re-invoking this CLI with the hidden `__worker` subcommand so it
  // works both under node (spawns `node dist/cli/index.js __worker <id>`) and as
  // a standalone SEA binary (spawns `<binary> __worker <id>`). Injectable for tests.
  launch: Launch = selfExec('__worker', [kshetraId]),
): StartResult {
  const existing = readPid(kshetraId);
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', kshetraId, pid: existing };
  }

  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  const logFd = openSync(workerLogPath(kshetraId), 'a');
  const child = spawn(launch.command, launch.args, {
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
