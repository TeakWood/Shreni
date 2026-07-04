import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type ActivityEvent =
  | { type: 'task_claimed';     kshetra: string; beadId: string; title: string }
  | { type: 'round_start';      kshetra: string; beadId: string; round: number; agent: 'silpi' | 'viharapala' }
  | { type: 'agent_text';       kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; text: string }
  | { type: 'agent_tool_call';  kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; tool: string; detail: string }
  | { type: 'silpi_done';       kshetra: string; beadId: string; round: number; summary: string; confidence: number; files: string[]; lintPassed: boolean; testsPassed: boolean }
  | { type: 'viharapala_done';  kshetra: string; beadId: string; round: number; verdict: 'APPROVE' | 'REJECT'; score: number; mustFix: string[] }
  | { type: 'task_done';        kshetra: string; beadId: string; title: string; approved: boolean; rounds: number }
  | { type: 'beads_synced';     kshetra: string }
  | { type: 'error';            kshetra: string; beadId?: string; message: string };

export type LoggedEvent = ActivityEvent & { ts: string };

function kshetraDir(kshetraId: string): string {
  return join(homedir(), '.shreni', 'kshetra', kshetraId);
}

export function logPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'activity.jsonl');
}

// Durable notification feed (stuck/end-state alerts) surfaced by Phalaka.
export function notificationsPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'notifications.jsonl');
}

// Pre-Feature-2 location, kept so `tail` can read older logs.
export function legacyLogPath(kshetraId: string): string {
  return join(homedir(), '.shreni', 'logs', `${kshetraId}.jsonl`);
}

// Worker-liveness heartbeat (the watchdog design §3.1 / OQ1). A bare file whose
// *mtime* is the liveness signal — decoupled from agent emits so a long SILENT tool
// call (a build, `pnpm test`, a slow `bd` op) no longer reads as a hung agent. The
// worker touches it on a fixed cadence while a phase is active; the watchdog reads
// its mtime instead of `activity.jsonl`'s. A file (not a state.json field) avoids a
// read-modify-write of state.json on every tick and can't clobber concurrent JSON
// writers (CLI pause/resume, setPhase).
export function heartbeatPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'heartbeat');
}

// Stamp the heartbeat: rewriting the (empty) file bumps its mtime to now. Best-effort
// — never let a heartbeat failure crash the worker.
export function touchHeartbeat(kshetraId: string): void {
  try {
    mkdirSync(kshetraDir(kshetraId), { recursive: true });
    writeFileSync(heartbeatPath(kshetraId), '', 'utf8');
  } catch {
    // Never let heartbeat stamping crash the worker
  }
}

export function emit(event: ActivityEvent): void {
  try {
    mkdirSync(kshetraDir(event.kshetra), { recursive: true });
    const entry: LoggedEvent = { ...event, ts: new Date().toISOString() };
    appendFileSync(logPath(event.kshetra), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Never let logging crash the worker
  }
}
