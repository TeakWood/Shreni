import { spawn } from 'child_process';
import { resolve } from 'path';
import { openSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { readPhalakaPid, clearPhalakaPid, isAlive } from '../phalaka/pid';
import { readToken, ensureToken } from '../phalaka/token';
import { DEFAULT_PORT } from '../phalaka/server';

export const PHALAKA_LOG_PATH = resolve(homedir(), '.shreni', 'phalaka.log');

export type PhalakaStartResult =
  | { status: 'started'; pid: number; port: number; url: string }
  | { status: 'already_running'; pid: number; port: number; url: string };

export type PhalakaStopResult =
  | { status: 'stopped'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale_pid_cleared' };

export interface PhalakaStatusResult {
  running: boolean;
  pid: number | null;
  url: string | null;
  token: string | null;
}

function serverScript(): string {
  return resolve(__dirname, 'phalaka-server.js');
}

function dashboardUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

export function startPhalaka(port = DEFAULT_PORT, script = serverScript()): PhalakaStartResult {
  const existing = readPhalakaPid();
  if (existing !== null && isAlive(existing)) {
    const token = ensureToken();
    return { status: 'already_running', pid: existing, port, url: dashboardUrl(port, token) };
  }

  mkdirSync(resolve(homedir(), '.shreni'), { recursive: true });
  const logFd = openSync(PHALAKA_LOG_PATH, 'a');

  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PHALAKA_PORT: String(port) },
  });

  if (child.pid === undefined) {
    throw new Error('Failed to spawn phalaka-server process');
  }

  child.unref();

  const token = ensureToken();
  return { status: 'started', pid: child.pid, port, url: dashboardUrl(port, token) };
}

export function stopPhalaka(): PhalakaStopResult {
  const pid = readPhalakaPid();

  if (pid === null) return { status: 'not_running' };

  if (!isAlive(pid)) {
    clearPhalakaPid();
    return { status: 'stale_pid_cleared' };
  }

  process.kill(pid, 'SIGTERM');
  clearPhalakaPid();
  return { status: 'stopped', pid };
}

export function statusPhalaka(port = DEFAULT_PORT): PhalakaStatusResult {
  const pid = readPhalakaPid();
  const running = pid !== null && isAlive(pid);
  const token = readToken();
  const url = running && token ? dashboardUrl(port, token) : null;
  return { running, pid: running ? pid : null, url, token };
}