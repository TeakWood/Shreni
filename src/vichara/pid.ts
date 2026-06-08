import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

export const VICHARA_PID_PATH = resolve(homedir(), '.shreni', 'vichara.pid');

export function writeVicharaPid(pid: number): void {
  mkdirSync(dirname(VICHARA_PID_PATH), { recursive: true });
  writeFileSync(VICHARA_PID_PATH, String(pid), 'utf8');
}

export function readVicharaPid(): number | null {
  try {
    const raw = readFileSync(VICHARA_PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function clearVicharaPid(): void {
  try {
    unlinkSync(VICHARA_PID_PATH);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}