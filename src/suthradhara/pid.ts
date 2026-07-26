import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { kshetraDir } from '../cli/pid';

// One Suthradhara session per Kshetra: state files sit alongside the worker's
// under ~/.shreni/kshetra/<id>/ so multiple Kshetras can each hold their own
// interview session without collision.

export function suthradharaPidPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'suthradhara.pid');
}

export function suthradharaLogPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'suthradhara.log');
}

export function writeSuthradharaPid(kshetraId: string, pid: number): void {
  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  writeFileSync(suthradharaPidPath(kshetraId), String(pid), 'utf8');
}

export function readSuthradharaPid(kshetraId: string): number | null {
  try {
    const raw = readFileSync(suthradharaPidPath(kshetraId), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function clearSuthradharaPid(kshetraId: string): void {
  try {
    unlinkSync(suthradharaPidPath(kshetraId));
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
