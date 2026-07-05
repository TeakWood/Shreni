import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { getSinkRegistry } from '../ext/index.js';

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

// Bump when the on-disk event envelope changes shape in a way a consumer must
// branch on. A consumer reads schemaVersion to know which fields to expect.
export const SCHEMA_VERSION = 1;

// The persisted envelope. `ts` is the emit time; `schemaVersion` pins the shape;
// `runId` is a correlation id stamped when a task is claimed and propagated
// through every downstream event of that attempt, so a consumer can group a run
// without reconstructing causality. `runId` is absent only for events emitted
// before any task has been claimed (e.g. a startup beads_synced).
export type LoggedEvent = ActivityEvent & {
  ts: string;
  schemaVersion: number;
  runId?: string;
};

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

// Current correlation id per kshetra. One task runs at a time per kshetra
// (enforced structurally by the scheduler), so a single id per kshetra is
// unambiguous: `task_claimed` mints a fresh id, every later event of that attempt
// reads it. Not cleared on task_done — a post-merge Parikshaka run keeps the
// claiming task's id, which is the correlation we want; the next `task_claimed`
// overwrites it.
const currentRunId = new Map<string, string>();

// Return the runId to stamp on an event, minting a new one when a task is
// claimed. Undefined before the first claim for a kshetra.
function runIdFor(event: ActivityEvent): string | undefined {
  if (event.type === 'task_claimed') {
    const id = randomUUID();
    currentRunId.set(event.kshetra, id);
    return id;
  }
  return currentRunId.get(event.kshetra);
}

// The correlation id of the in-flight (or most recently claimed) attempt for a
// kshetra. Used to key per-run usage records (runner.ts) to the same attempt the
// activity events carry. Empty string when no task has been claimed yet.
export function getCurrentRunId(kshetraId: string): string {
  return currentRunId.get(kshetraId) ?? '';
}

// Publish a lifecycle/activity event. Stamps the envelope (ts + schemaVersion +
// runId) and fans it out through the EventSink registry. The default registry is
// [localFileSink], which appends to activity.jsonl exactly as before — so with no
// extension loaded the on-disk output is unchanged except the new envelope
// fields. Never throws: the registry isolates every sink.
export function emit(event: ActivityEvent): void {
  const runId = runIdFor(event);
  const entry: LoggedEvent = {
    ...event,
    ts: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    ...(runId ? { runId } : {}),
  };
  getSinkRegistry().handle(entry);
}
