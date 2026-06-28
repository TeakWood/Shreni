import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type ActivityEvent =
  | { type: 'task_claimed';     kshetra: string; beadId: string; title: string }
  | { type: 'round_start';      kshetra: string; beadId: string; round: number; agent: 'silpi' | 'viharapala' }
  | { type: 'silpi_done';       kshetra: string; beadId: string; round: number; summary: string; confidence: number; files: string[]; lintPassed: boolean; testsPassed: boolean }
  | { type: 'viharapala_done';  kshetra: string; beadId: string; round: number; verdict: 'APPROVE' | 'REJECT'; score: number; mustFix: string[] }
  | { type: 'task_done';        kshetra: string; beadId: string; title: string; approved: boolean; rounds: number }
  | { type: 'beads_synced';     kshetra: string }
  | { type: 'error';            kshetra: string; beadId?: string; message: string };

export type LoggedEvent = ActivityEvent & { ts: string };

const logsDir = join(homedir(), '.shreni', 'logs');

export function logPath(kshetraId: string): string {
  return join(logsDir, `${kshetraId}.jsonl`);
}

export function emit(event: ActivityEvent): void {
  try {
    mkdirSync(logsDir, { recursive: true });
    const entry: LoggedEvent = { ...event, ts: new Date().toISOString() };
    appendFileSync(logPath(event.kshetra), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Never let logging crash the daemon
  }
}
