import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

export const PID_PATH = resolve(homedir(), '.shreni', 'shreni.pid');

export function writePid(pid: number): void {
  mkdirSync(dirname(PID_PATH), { recursive: true });
  writeFileSync(PID_PATH, String(pid), 'utf8');
}

export function readPid(): number | null {
  try {
    const raw = readFileSync(PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function clearPid(): void {
  try {
    unlinkSync(PID_PATH);
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