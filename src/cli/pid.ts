import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Per-kshetra layout under ~/.shreni/kshetra/<id>/:
//   worker.pid       — detached worker process id
//   activity.jsonl   — structured event log (see activity-log.ts)
//   worker.log       — worker stdout/stderr

export function shreniDir(): string {
  return join(homedir(), '.shreni');
}

export function kshetraDir(kshetraId: string): string {
  return join(shreniDir(), 'kshetra', kshetraId);
}

export function workerPidPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'worker.pid');
}

export function workerLogPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'worker.log');
}

export function writePid(kshetraId: string, pid: number): void {
  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  writeFileSync(workerPidPath(kshetraId), String(pid), 'utf8');
}

export function readPid(kshetraId: string): number | null {
  try {
    const raw = readFileSync(workerPidPath(kshetraId), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function clearPid(kshetraId: string): void {
  try {
    unlinkSync(workerPidPath(kshetraId));
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
