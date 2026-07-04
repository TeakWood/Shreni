import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

export const PHALAKA_PID_PATH = resolve(homedir(), '.shreni', 'phalaka.pid');

export function writePhalakaPid(pid: number): void {
  mkdirSync(dirname(PHALAKA_PID_PATH), { recursive: true });
  writeFileSync(PHALAKA_PID_PATH, String(pid), 'utf8');
}

export function readPhalakaPid(): number | null {
  try {
    const raw = readFileSync(PHALAKA_PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function clearPhalakaPid(): void {
  try {
    unlinkSync(PHALAKA_PID_PATH);
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