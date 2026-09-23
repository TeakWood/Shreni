import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getSinkRegistry } from '../ext/index.js';
import type { Phase } from './lifecycle.js';
import type { AblationKey } from '../kshetra/ablation.js';
// Per-Kshetra path derivations live in kshetra/state-locations.ts (single
// source). legacyLogPath is re-exported so cli/tail.ts keeps its import site.
import { kshetraDir, legacyLogPath } from '../kshetra/state-locations.js';

export { legacyLogPath };

export type ActivityEvent =
  | { type: 'task_claimed';     kshetra: string; beadId: string; title: string }
  | { type: 'round_start';      kshetra: string; beadId: string; round: number; agent: 'silpi' | 'viharapala' }
  | { type: 'agent_text';       kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; text: string }
  | { type: 'agent_tool_call';  kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; tool: string; detail: string }
  // `gatesElapsedMs` (epic hto / Study A3): the round-level elapsed time of the
  // whole gate block (measureHealth start → evaluateGates resolved), the value
  // totals use — per-gate durations (on gate_result) are attribution-only and must
  // NOT be summed, since parallel gates overlap. Additive optional; absent on the
  // PR-followup path (no gate block) and on pre-A3 data.
  | { type: 'silpi_done';       kshetra: string; beadId: string; round: number; summary: string; confidence: number; files: string[]; lintPassed: boolean; testsPassed: boolean; gatesElapsedMs?: number }
  | { type: 'viharapala_done';  kshetra: string; beadId: string; round: number; verdict: 'APPROVE' | 'REJECT'; score: number; mustFix: string[] }
  | { type: 'task_done';        kshetra: string; beadId: string; title: string; approved: boolean; rounds: number }
  // `durationMs` (epic hto / Study A3): monotonic time spent in the sync,
  // measured at the site (beads.ts). Additive optional — absent on pre-A3 data.
  | { type: 'beads_synced';     kshetra: string; durationMs?: number }
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
  // `durationMs` (epic hto / Study A3): monotonic time this ONE gate's work took,
  // measured at its site (test=measureHealth, lint=runLintGate, coverage/diffSize
  // inside evaluateGates). Attribution-only — never summed into a round total
  // (parallel gates overlap; the round total is silpi_done.gatesElapsedMs).
  // Additive optional; absent on pre-A3 data.
  // `ablations` (epic 8wi / Study B1): the generic marker, present (['enforcement'])
  // ONLY on a failing gate whose block was downgraded to warn by the enforcement
  // ablation — so a suppressed blocker is distinguishable from a configured warn.
  // Consumers (shreni show, computeMetrics) key off it generically.
  | { type: 'gate_result';      kshetra: string; beadId: string; round: number; gate: string; verdict: 'pass' | 'fail' | 'warn' | 'skip'; durationMs?: number; ablations?: AblationKey[] }
  // merge_done: approved work landed (or a PR was opened to land it). `sha` is the
  // squash commit for mergePolicy 'push'; `pr` is the PR number for 'pr'.
  // `durationMs` (epic hto / Study A3): monotonic time the merge + push (or PR
  // open) took, measured at the site (merge.ts). Additive optional; absent on
  // pre-A3 data.
  | { type: 'merge_done';       kshetra: string; beadId: string; mergePolicy: 'push' | 'pr'; sha?: string; pr?: number; durationMs?: number }
  // run_usage: a per-run token/cost SUMMARY folded from the UsageEntry the meter
  // writes to usage.jsonl (epic 4a2.5). Carries the headline totals + cost, not
  // the full record — the cache/tool breakdown stays in usage.jsonl, referenced
  // by the envelope's runId. `priced` false means costUsd is an "unknown"
  // placeholder, not a real $0. One per metered run finalization (ok and error),
  // mirroring usage.jsonl 1:1. Suthradhara emits one per planning session too
  // (epic fnd.6), from the launcher loop right after its meter.record — same
  // 1:1 discipline, so a planning session shows up in the run_usage stream
  // alongside the executors rather than only in usage.jsonl.
  // `contextWindow` (epic 408/A1, part B): the main-loop model's context-window
  // size for the run, folded from the UsageRecord so the ledger's run_usage entry
  // carries peak_context's denominator. Additive OPTIONAL — absent when unknown
  // (non-claude adapter, or no unambiguous main-loop-model entry); readers treat
  // absent as unknown, so no SCHEMA_VERSION bump is needed.
  // `durationMs` (epic hto / Study A3): monotonic time the provider subprocess ran
  // for this attempt (spawn → exit), measured at the site (runner.ts) on BOTH the
  // ok and errored path — a failed session still consumed real time. Additive
  // optional; absent on pre-A3 data. Folded from the UsageRecord, so usage.jsonl
  // carries the same value (Shreni-beads-dt7).
  // INVARIANT (dt7): this entry is a PROJECTION of the UsageEntry — every
  // non-envelope field here must also exist on UsageEntry. Add a field to the
  // record first; the type guard in ext/types.ts fails typecheck otherwise.
  | { type: 'run_usage';        kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka' | 'suthradhara'; provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; priced: boolean; outcome: 'ok' | 'error'; contextWindow?: number; durationMs?: number }
  // turn_usage (RUN-LOG, epic 408/A1): per-MODEL-CALL context usage, the raw input
  // to Figure 1 (effective_context vs. assistant-turn index). It is O(turns) —
  // strictly run-log, activity.jsonl only, NOT decision-grade and NOT usage.jsonl
  // (that holds one priced summary per run). The unit is the model call, not the
  // stream event: dedupe on `messageId` upstream or the curve shows false
  // stair-steps. Only the INPUT side is trusted per call (output_tokens on
  // intermediate assistant events may be partial; cost keeps coming from the
  // priced 'result' summary via run_usage). `turnIndex` is 0-based and counts the
  // main thread and each sidechain separately. `sidechain` true tags a subagent
  // (Task tool) call, which lives in a DIFFERENT context window and must not be
  // mixed into the main-thread curve. effective_context is DERIVED at read time
  // (inputTokens + cacheReadTokens + cacheCreationTokens), never stored — same
  // store-raw-counters principle as run_usage. Provider-neutral; only the Claude
  // adapter populates it today (408.2), other adapters stay no-ops.
  | { type: 'turn_usage';       kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; provider: string; model: string; turnIndex: number; messageId: string; inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; sidechain: boolean }
  // context_compacted (DECISION-GRADE, epic 408/A1): the provider CLI compacted
  // the run's context — from this point the agent works from a summary of its own
  // earlier work. It is rare (0–few per run) so ledger volume stays bounded, and
  // it is audit-relevant, so it goes to the ledger (decision 5). RECORD-ONLY:
  // Shreni does not abort/retry/replan on it (decision 6) — reacting would change
  // the treatment E1 measures. `trigger` distinguishes an automatic boundary from
  // a manual /compact ('unknown' when the provider surfaced no compact_metadata —
  // never fabricated as 'auto'); `preTokens` is the context size just before the
  // boundary; `turnIndex` is the last main-thread turn before it. It must NOT be
  // visible to the 'agent' audience — it describes the agent's own memory loss,
  // not task context. Provider-neutral; only the Claude adapter populates it (408.3).
  | { type: 'context_compacted'; kshetra: string; beadId: string; agent: 'silpi' | 'viharapala' | 'parikshaka'; provider: string; model: string; trigger: 'auto' | 'manual' | 'unknown'; preTokens: number; turnIndex: number }
  // worker_started — the LOT MANIFEST (epic yrk / Study B2): one entry per worker
  // process (or `shreni drain` / its one-cycle `shreni run` alias) start, recording everything in force
  // for that lot. A lot is the set of work produced under identical conditions —
  // one worker process with its once-loaded config — and is ORTHOGONAL to the bead
  // hierarchy (a lot spans many beads; a bead can span lots on restart). So this
  // event carries NO beadId: it is lot-level, not task-level. Its `lotId` is NOT a
  // field here — it rides the envelope like `runId` (see emit / getCurrentLotId),
  // so EVERY subsequent ledger/activity entry in the process joins back to this
  // manifest by lotId. `entrypoint` distinguishes the long-lived worker from a
  // drain and from `shreni run` (a one-cycle drain since Shreni-beads-nhw; older
  // 'run' records predate that and carry no ledger trail — readers must keep
  // accepting the value either way). `subject` (what was changed: repo, base SHA, resolved config) and
  // `process` (what did the changing: build identity, CLI versions) start EMPTY
  // here (yrk.1 plumbing) and are populated by the collectors in yrk.2/yrk.3.
  // `labels` are opaque operator tags (--label k=v, yrk.4), recorded verbatim —
  // Shreni never branches on them. Decision-grade → ledger (isDecisionGrade);
  // audience 'audit' (about the machinery, never folded into an agent prompt).
  | { type: 'worker_started';   kshetra: string; entrypoint: 'worker' | 'run' | 'drain'; subject: Record<string, unknown>; process: Record<string, unknown>; labels: Record<string, string> }
  // drain_finished (epic 7h3 / Study B3): the decision-grade record of WHY a
  // `shreni drain` ended — its reason, exit code, scope, per-status counts, and
  // each still-open in-scope bead with its stall reason. O(1) per drain,
  // audit-relevant provenance: the reason a trial ended belongs in the git-tracked
  // ledger, not only on a terminal that scrolls away. Decision-grade → ledger.
  | { type: 'drain_finished';   kshetra: string; lotId: string; reason: string; scope: string | null; exitCode: number; counts: { filed: number; merged: number; open: number }; stalled: { beadId: string; reason: string }[]; outOfScopeFiled: string[]; maxCycles?: number }
  // state_frozen / state_restored (DECISION-GRADE, epic Shreni-beads-ius / Study B4):
  // freeze/restore provenance. Kshetra-level, not bead-level (no beadId — like
  // worker_started), audience 'audit' (about the whole kshetra's state, never an
  // agent prompt). `snapshotId` is the manifest's stable content hash so a lot
  // manifest or trial log can name the exact starting state. state_restored is
  // emitted AFTER a restore into the restored ledger, so a rewound ledger can be
  // told apart from one that simply lost history: `shreni show` renders it as an
  // explicit boundary ("entries above predate the restore").
  | { type: 'state_frozen';     kshetra: string; snapshotId: string; beadCount: number; memoryCount: number; beadsSha: string | null; labels: Record<string, string> }
  | { type: 'state_restored';   kshetra: string; snapshotId: string; beadCount: number; memoryCount: number; beadsSha: string | null; archivePath: string; clean: boolean }
  // phase_changed (RUN-LOG, epic hto / Study A3): one scheduler phase transition,
  // with `heldMs` = the monotonic time spent in `from` before moving to `to`. It
  // is how the report attributes select/prepare overhead and idle (poll) time,
  // which state.json (overwrite-only) cannot recover. It is O(ticks) — strictly
  // run-log (activity.jsonl only), operator audience, NEVER the ledger. To keep an
  // idle worker from appending ~2 events every poll forever, CONSECUTIVE empty
  // polls (IDLE→SELECTING→IDLE, no work) are coalesced into ONE summary emitted
  // when work next appears or on shutdown: `polls` is the number of empty polls
  // folded in and `heldMs` their total idle time, so idle between claims is still
  // recoverable exactly. `beadId` is optional (unset for the pre-claim phases).
  | { type: 'phase_changed';    kshetra: string; from: Phase; to: Phase; beadId?: string; heldMs: number; polls?: number }
  // review_ablated (DECISION-GRADE, epic 8wi / Study B1): a round whose gates passed
  // was merged WITHOUT Viharapala because the `review` switch is active. It is
  // emitted INSTEAD OF viharapala_done — never as an APPROVE (decision 8): the
  // ledger must not make an ablated outcome look like a real review. `ablations`
  // carries the generic marker (['review']) that shreni show labels and
  // computeMetrics excludes off (8wi.4), so a new switch needs no consumer change.
  | { type: 'review_ablated';   kshetra: string; beadId: string; round: number; ablations: AblationKey[] }
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
  // `lotId` is the governing lot manifest's id (epic yrk / Study B2), stamped on
  // every envelope the same way `runId` is — minted once per worker process at its
  // worker_started, then read by emit() for all subsequent events. Absent only for
  // events emitted before the process's worker_started (there are none in the
  // worker/run entrypoints, which emit it first) or by a build predating B2.
  lotId?: string;
};

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

// The governing lot id per kshetra (epic yrk / Study B2). One lot = one worker
// process and its once-loaded configuration, so this is minted ONCE per process
// per kshetra by emitLotManifest at worker/run start, then read by emit() to stamp
// every subsequent envelope. Never overwritten within a process: a worker drives
// exactly one kshetra for its lifetime, so a second worker_started for the same
// kshetra would mean a genuinely new process (and a fresh map).
const currentLotId = new Map<string, string>();

// The governing lot id for a kshetra, or empty string before its worker_started.
// Mirrors getCurrentRunId. Read by tests and by any code that needs to correlate
// out-of-band records (e.g. usage) to the lot the activity events carry.
export function getCurrentLotId(kshetraId: string): string {
  return currentLotId.get(kshetraId) ?? '';
}

// Emit the lot manifest (epic yrk / Study B2) — the SINGLE shared entrypoint for
// every worker-runtime startup (`shreni start`'s worker, `shreni drain`, and its
// one-cycle `shreni run` alias). It mints a fresh lotId, records it so emit()
// stamps it on this and every later envelope, then emits one worker_started
// carrying the (initially empty) subject/process sections and the opaque labels.
// Returns the minted lotId.
//
// Must be called AFTER the ledger sink is registered so the manifest reaches
// ledger.jsonl (the worker runtime does both, in that order). 'run' stays in the
// entrypoint union: it is still written by the alias, and pre-nhw 'run' records
// (which had no ledger sink) exist in history and must keep parsing. Subject/process are populated by the
// collectors (yrk.2/yrk.3); this foundation emits them empty so the plumbing —
// envelope stamping, decision-grade routing, no-bead handling — is testable first.
export function emitLotManifest(
  kshetraId: string,
  entrypoint: 'worker' | 'run' | 'drain',
  labels: Record<string, string> = {},
  sections: { subject?: Record<string, unknown>; process?: Record<string, unknown> } = {},
): string {
  const lotId = randomUUID();
  currentLotId.set(kshetraId, lotId);
  emit({
    type: 'worker_started',
    kshetra: kshetraId,
    entrypoint,
    // Populated by the caller's collectors (build identity in yrk.2, repo/config/
    // CLI versions in yrk.3). This module stays pure — it does not read git, the
    // config, or the build stamp itself; it only emits what it is handed, so it
    // takes on no dependency on KshetraConfig or the filesystem beyond the sink.
    subject: sections.subject ?? {},
    process: sections.process ?? {},
    labels,
  });
  return lotId;
}

// Publish a lifecycle/activity event. Stamps the envelope (ts + schemaVersion +
// runId) and fans it out through the EventSink registry. The default registry is
// [localFileSink], which appends to activity.jsonl exactly as before — so with no
// extension loaded the on-disk output is unchanged except the new envelope
// fields. Never throws: the registry isolates every sink.
export function emit(event: ActivityEvent): void {
  const runId = runIdFor(event);
  const lotId = currentLotId.get(event.kshetra);
  const entry: LoggedEvent = {
    ...event,
    ts: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    ...(runId ? { runId } : {}),
    ...(lotId ? { lotId } : {}),
  };
  getSinkRegistry().handle(entry);
}
