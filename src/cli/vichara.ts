import { spawn } from 'child_process';
import { resolve } from 'path';
import { openSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { readVicharaPid, clearVicharaPid, isAlive } from '../vichara/pid';
import { readToken, ensureToken } from '../vichara/token';
import { DEFAULT_PORT } from '../vichara/server';

export const VICHARA_LOG_PATH = resolve(homedir(), '.shreni', 'vichara.log');

export type VicharaStartResult =
  | { status: 'started'; pid: number; port: number; url: string }
  | { status: 'already_running'; pid: number; port: number; url: string };

export type VicharaStopResult =
  | { status: 'stopped'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale_pid_cleared' };

export interface VicharaStatusResult {
  running: boolean;
  pid: number | null;
  url: string | null;
  token: string | null;
}

function serverScript(): string {
  return resolve(__dirname, 'vichara-server.js');
}

export function startVichara(
  port = DEFAULT_PORT,
  script = serverScript(),
): VicharaStartResult {
  const existing = readVicharaPid();
  if (existing !== null && isAlive(existing)) {
    const token = ensureToken();
    const url = `http://127.0.0.1:${port}/?token=${token}`;
    return { status: 'already_running', pid: existing, port, url };
  }

  mkdirSync(resolve(homedir(), '.shreni'), { recursive: true });
  const logFd = openSync(VICHARA_LOG_PATH, 'a');

  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, VICHARA_PORT: String(port) },
  });

  if (child.pid === undefined) {
    throw new Error('Failed to spawn vichara-server process');
  }

  child.unref();

  const token = ensureToken();
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  return { status: 'started', pid: child.pid, port, url };
}

export function stopVichara(): VicharaStopResult {
  const pid = readVicharaPid();

  if (pid === null) return { status: 'not_running' };

  if (!isAlive(pid)) {
    clearVicharaPid();
    return { status: 'stale_pid_cleared' };
  }

  process.kill(pid, 'SIGTERM');
  clearVicharaPid();
  return { status: 'stopped', pid };
}

export function statusVichara(port = DEFAULT_PORT): VicharaStatusResult {
  const pid = readVicharaPid();
  const running = pid !== null && isAlive(pid);
  const token = readToken();
  const url = running && token ? `http://127.0.0.1:${port}/?token=${token}` : null;
  return { running, pid: running ? pid : null, url, token };
}