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
  | { type: 'error';            kshetra: string; beadId?: string; message: string }
  // Decision-grade kinds the ledger needs (epic 4a2.2). Purely ADDITIVE — every
  // existing consumer (tail, report, phalaka, metrics) switches on the type
  // discriminant with a default/filter, so these do not affect them. They are
  // emitted at the site where the decision actually happens (runner/dispatch/merge)
  // and folded into ledger.jsonl by ledgerSink (4a2.3). Evidence is REFERENCED by
  // the envelope's runId into activity.jsonl, never inlined here.
  //
  // run_started: a permitted agent run begins. `manifestHash` fingerprints the
  // exact run inputs (prompts + provider/model/tools) so two runs are comparable
  // and a run is reproducible; the per-token stream lives in activity.jsonl under
  // the same runId.
  | { type: 'run_started';      kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; provider: string; model: string; manifestHash: string }
  // policy_decision: one PolicySource call and its resolved answer. `policy` names
  // which call — 'selectModel' carries the resolved provider/model; 'mayProceed'
  // carries allow/deny + reason.
  | { type: 'policy_decision';  kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka' | 'suthradhara'; policy: 'selectModel' | 'mayProceed'; provider?: string; model?: string; allowed?: boolean; reason?: string }
  // gate_result: one gate's verdict for a round. The gate's raw output is NOT
  // inlined — it is referenced by the envelope's runId into the run log. 'skip'
  // is distinct from 'pass' (4a2.10): a gate with no configured command (coverage,
  // lint) or an unmeasurable one (diffSize) DID NOT RUN — recording it as a
  // genuine pass would mislead a reader of the git-tracked ledger years later.
  | { type: 'gate_result';      kshetra: string; beadId: string; round: number; gate: string; verdict: 'pass' | 'fail' | 'warn' | 'skip' }
  // merge_done: approved work landed (or a PR was opened to land it). `sha` is the
  // squash commit for mergePolicy 'push'; `pr` is the PR number for 'pr'.
  | { type: 'merge_done';       kshetra: string; beadId: string; mergePolicy: 'push' | 'pr'; sha?: string; pr?: number }
  // run_usage: a per-run token/cost SUMMARY folded from the UsageEntry the meter
  // writes to usage.jsonl (epic 4a2.5). Carries the headline totals + cost, not
  // the full record — the cache/tool breakdown stays in usage.jsonl, referenced
  // by the envelope's runId. `priced` false means costUsd is an "unknown"
  // placeholder, not a real $0. One per metered run finalization (ok and error),
  // mirroring usage.jsonl 1:1. Suthradhara emits one per planning session too
  // (epic fnd.6), from the launcher loop right after its meter.record — same
  // 1:1 discipline, so a planning session shows up in the run_usage stream
  // alongside the executors rather than only in usage.jsonl.
  | { type: 'run_usage';        kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka' | 'suthradhara'; provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; priced: boolean; outcome: 'ok' | 'error' }
  // Suthradhara (interactive planning session) lifecycle events (epic fnd). The
  // launched session runs interactive with no stream-json, so these lifecycle
  // events — not the per-token agent_text/agent_tool_call the executors emit — are
  // its monitoring surface; fnd.2 emits them from the launcher control loop, fnd.5
  // renders them. Keyed by kshetra + sessionId (the shreni session id, distinct
  // from the beadId/runId correlation the executor loop uses). Token usage is
  // recovered separately from the session transcript (fnd.3/fnd.4), not from these.
  | { type: 'suthradhara_launched';      kshetra: string; sessionId: string; claudeSessionId: string; resume: boolean }
  | { type: 'suthradhara_plan_filed';    kshetra: string; sessionId: string; epicId: string; docPath: string; summary: string }
  | { type: 'suthradhara_doc_pushed';    kshetra: string; sessionId: string; branch: string; docPath: string }
  | { type: 'suthradhara_menu_choice';   kshetra: string; sessionId: string; choice: 'extend' | 'new' | 'end' }
  | { type: 'suthradhara_session_ended'; kshetra: string; sessionId: string; epicId?: string };

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

// Per-run token/cost accounting feed (epic g2k). One UsageEntry per finalized
// agent run, appended by the default UsageMeter (src/ext/defaults.ts). Sits
// beside activity.jsonl in the same Kshetra dir; the metrics aggregator (g2k.2)
// and spend accounting (F5) read it.
export function usagePath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'usage.jsonl');
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
