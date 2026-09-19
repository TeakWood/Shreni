// The ledger (epic Shreni-beads-4a2): a git-tracked, append-only record of
// Shreni's own DECISIONS, distinct from activity.jsonl's high-volume run log.
// This module is the foundation (4a2.1): PURE functions, NO I/O. It defines the
// on-disk envelope, the decision-grade classifier, the audience vocabulary, and
// the single gated read path. The sink that writes it (4a2.3) and the reader
// that renders it (4a2.6) build on these; the new decision-grade kinds (4a2.2)
// and the usage summary (4a2.5) extend the two switches below.
//
// Three settled design decisions from the epic live here as code, not comments:
//   1. Audience is DERIVED at read time from the event kind (audienceFor), never
//      stored on an entry. Storing it would freeze a visibility policy into an
//      append-only git-tracked record; a later change to what agents may see
//      must apply to historical entries too. Audience is a property of the KIND,
//      so it is reconstructable for every entry ever written — unlike runId,
//      which must be captured at write time.
//   2. Evidence is REFERENCED by runId into activity.jsonl / usage.jsonl, never
//      inlined. Ledger volume stays O(lifecycle rounds), never O(tool calls).
//   3. No migration: a NEW file with its OWN LEDGER_SCHEMA_VERSION. activity.jsonl
//      v1 is untouched. Readers tolerate unknown kinds and unknown fields — this
//      file is meant to be read years later.

import type { LoggedEvent } from '../sthapathi/activity-log.js';

// The ledger's schema version, versioned INDEPENDENTLY of the activity log's
// SCHEMA_VERSION (activity-log.ts) and USAGE_SCHEMA_VERSION (ext/types.ts) — the
// three feeds evolve separately. Bump when the LedgerEntry envelope changes
// shape in a way a reader must branch on.
export const LEDGER_SCHEMA_VERSION = 1;

// Who a given ledger entry is FOR. Not a stored tag — derived from the kind by
// audienceFor at read time.
//   • agent    — safe to fold into an agent's bounded context (buildContext).
//   • operator — for a human running the harness; too internal/noisy for an
//                agent prompt, but not sensitive.
//   • audit    — provenance/accountability record read by humans reviewing what
//                happened; never injected into an agent prompt.
export type LedgerAudience = 'agent' | 'operator' | 'audit';

// The persisted ledger envelope, one JSON object per line in ledger.jsonl. It
// carries only what cannot be reconstructed at read time:
//   • ts / schemaVersion — order entries and know which fields to expect.
//   • kshetra / beadId   — the task this decision belongs to (join key for
//                          `shreni show <bead>`, 4a2.6).
//   • runId              — correlation into activity.jsonl / usage.jsonl, where
//                          the evidence lives. Absent only for an entry emitted
//                          before any task was claimed.
//   • kind               — the LoggedEvent discriminant this entry was mapped
//                          from; audienceFor derives audience from it.
//   • payload            — the source event minus the envelope fields already
//                          lifted out above.
export interface LedgerEntry {
  ts: string;
  schemaVersion: number;
  kshetra: string;
  // The bead this decision belongs to. Empty string for a lot-level entry with no
  // governing bead — today only worker_started (epic yrk / Study B2), which
  // records the conditions a whole worker process ran under, not a single task.
  // Kept a required string (not optional) so readLedger's `entry.beadId === …`
  // stays a safe comparison; a bead query simply never matches ''.
  beadId: string;
  runId?: string;
  // The governing lot manifest's id (epic yrk / Study B2), lifted from the
  // envelope the same way runId is. Every entry written after a worker_started
  // carries it, joining that entry to the manifest that recorded the conditions it
  // ran under. Absent on entries written before B2 (readers tolerate its absence).
  lotId?: string;
  kind: LoggedEvent['type'];
  payload: Record<string, unknown>;
}

// The subset of LoggedEvent kinds that record a DECISION worth committing to git
// — the execution record beads does not already carry. IN today: the lifecycle
// turning points (claim, each executor's verdict, task completion). 4a2.2 and
// 4a2.5 add their new kinds here; the exhaustive switch below forces them to.
// OUT: the high-volume run-log tier (agent_text, agent_tool_call) that stays
// local, pure telemetry (round_start, beads_synced, error), and the Suthradhara
// planning-session lifecycle — none is a committed decision about a bead.
//
// Deliberately an inclusion list, not `!isRunLog`: a new kind is NOT decision-
// grade until someone opts it in here, so adding a kind never silently grows
// what gets committed to the shared repo.
export function isDecisionGrade(ev: LoggedEvent): boolean {
  switch (ev.type) {
    case 'task_claimed':
    case 'silpi_done':
    case 'viharapala_done':
    case 'task_done':
    case 'run_started':
    case 'policy_decision':
    case 'gate_result':
    case 'merge_done':
    case 'run_usage':
    // context_compacted is decision-grade (epic 408 decision 5): rare, audit-
    // relevant, goes to the ledger. turn_usage is NOT — it is O(turns) run-log.
    case 'context_compacted':
    // worker_started is the lot manifest (epic yrk / Study B2 decision 3): O(1)
    // per worker start, audit-relevant provenance of the conditions in force. It
    // goes to the ledger — the only git-tracked, shared store.
    case 'worker_started':
    // review_ablated (epic 8wi / Study B1): a round merged without review. It is a
    // decision-grade provenance record — the ledger must show review did NOT happen.
    case 'review_ablated':
      return true;
    case 'round_start':
    case 'agent_text':
    case 'agent_tool_call':
    // turn_usage is the high-volume per-model-call run-log tier (epic 408): it
    // stays in activity.jsonl and must never grow the git-tracked ledger.
    case 'turn_usage':
    // phase_changed is O(ticks) run-log (epic hto): scheduler phase timing that
    // must never reach the git-tracked ledger.
    case 'phase_changed':
    case 'beads_synced':
    case 'error':
    case 'suthradhara_launched':
    case 'suthradhara_plan_filed':
    case 'suthradhara_doc_pushed':
    case 'suthradhara_menu_choice':
    case 'suthradhara_session_ended':
      return false;
  }
  // No default: the switch is exhaustive over LoggedEvent. A newly-added kind
  // fails to compile here until it is explicitly classified in or out, so no
  // kind is ever silently committed to — or silently dropped from — the ledger.
  return assertNever(ev);
}

// Derive the audience for a ledger entry FROM ITS KIND. Exhaustive switch, NO
// default case: adding a LoggedEvent kind without classifying it here is a
// COMPILE error. That is the load-bearing guarantee — it is what protects agent
// context as more agent roles/kinds are added later. A tag convention on entries
// would not, because a tag can be forgotten; a missing switch arm cannot.
//
// Only decision-grade kinds ever reach ledger.jsonl, but every union member is
// classified so the exhaustiveness check covers the whole type. Non-decision
// kinds are 'audit' — the most restrictive audience — so a misrouted entry is
// never handed to an agent.
export function audienceFor(kind: LoggedEvent['type']): LedgerAudience {
  switch (kind) {
    // Turning points an agent picking up related context benefits from seeing.
    case 'task_claimed':
    case 'silpi_done':
    case 'viharapala_done':
    case 'task_done':
      return 'agent';
    // Operator-facing execution detail (4a2.2): model routing, the go/no-go
    // decision, and gate outcomes. Useful to a human at the console, too
    // internal/noisy to fold into an agent's bounded context.
    case 'run_started':
    case 'policy_decision':
    case 'gate_result':
    case 'run_usage':
    // phase_changed is operator-facing execution detail (epic hto) — scheduler
    // phase timing for the console/report. Not decision-grade, so it never reaches
    // the ledger; classified here only to keep this switch exhaustive.
    case 'phase_changed':
      return 'operator';
    // Pure provenance — what landed on main and how. An accountability record.
    case 'merge_done':
    // context_compacted is a decision-grade provenance record of the agent's own
    // memory loss (epic 408). It is audit-relevant, and — critically — must NOT
    // be visible to the 'agent' audience: it describes the agent's lost context,
    // not task context. 'audit' is the most restrictive audience, so it is never
    // folded into an agent prompt.
    case 'context_compacted':
    // worker_started is the lot manifest (epic yrk / Study B2): audit-relevant
    // provenance about the machinery a lot ran under, NOT about the task. It must
    // never be folded into an agent prompt, so it takes the most restrictive
    // audience — 'audit' — which also keeps it out of readLedger({audience:'agent'}).
    case 'worker_started':
    // review_ablated (epic 8wi / Study B1): provenance that review was skipped —
    // audit-relevant, and must never read to an agent as task context.
    case 'review_ablated':
      return 'audit';
    // Non-decision kinds. They never reach ledger.jsonl (isDecisionGrade filters
    // them at the sink), but are classified so this switch stays exhaustive over
    // the whole LoggedEvent union. Audit-only, the most restrictive audience.
    case 'round_start':
    case 'agent_text':
    case 'agent_tool_call':
    // turn_usage: high-volume per-model-call run-log (epic 408). Follows the
    // run-log convention (agent_text / agent_tool_call) — audit-only, and it never
    // reaches the ledger because it is not decision-grade.
    case 'turn_usage':
    case 'beads_synced':
    case 'error':
    case 'suthradhara_launched':
    case 'suthradhara_plan_filed':
    case 'suthradhara_doc_pushed':
    case 'suthradhara_menu_choice':
    case 'suthradhara_session_ended':
      return 'audit';
  }
  // No default: exhaustive over LoggedEvent['type']. A new kind added without an
  // arm makes `kind` non-never here and fails the assertNever type check.
  return assertNever(kind);
}

// What a given audience is permitted to see. 'audit' sees everything; 'operator'
// sees operator + agent; 'agent' sees only agent-audience entries. Monotonic:
// broader audiences are supersets, so the gate is a single rank comparison.
const AUDIENCE_RANK: Record<LedgerAudience, number> = {
  agent: 0,
  operator: 1,
  audit: 2,
};

// The SINGLE gated read path. Every consumer — buildContext (dispatch.ts) and
// `shreni show` (4a2.6) alike — reads the ledger THROUGH this, never by ranking
// entries itself. That single choke point, plus audienceFor's exhaustive switch,
// is what keeps a newly-added kind out of agent context until it is deliberately
// classified as 'agent'.
//
// PURE (no I/O, per 4a2.1): it takes already-parsed entries — the file read that
// produces them lives in a later bead's IO wrapper and is fed through here, so
// this gate is the only thing that applies the audience policy. `opts.audience`
// is the caller's clearance: it receives every entry for `beadId` whose own
// derived audience is at or below that clearance. Entries for a different beadId
// are dropped (the ledger is one shared file across beads). An entry whose kind
// this build cannot classify (written by a newer Shreni) is treated as audit-
// only and withheld from non-audit readers rather than crashing the read.
export function readLedger(
  entries: LedgerEntry[],
  beadId: string,
  opts: { audience: LedgerAudience },
): LedgerEntry[] {
  const clearance = AUDIENCE_RANK[opts.audience];
  return entries.filter(entry => entry.beadId === beadId && rankOf(entry.kind) <= clearance);
}

// Rank an entry's kind, tolerating a kind this build has never heard of. A known
// kind ranks by audienceFor; an unknown one (forward-compat entry from a newer
// Shreni) ranks as audit — the most restrictive — so it is withheld from
// agent/operator readers rather than leaked or crashed on. Robust to arbitrary
// on-disk strings, not just the declared union.
function rankOf(kind: LoggedEvent['type']): number {
  try {
    return AUDIENCE_RANK[audienceFor(kind)];
  } catch {
    return AUDIENCE_RANK.audit;
  }
}

// Parse raw ledger.jsonl content into typed entries. PURE (operates on a string,
// not a file) so it is unit-testable and so the IO wrapper that reads the file
// (a later bead) is a one-liner over it. Tolerant, because this file is read
// years later by possibly-older code: blank lines are skipped, a corrupt/half-
// written line is dropped rather than failing the whole read, and unknown fields
// on an otherwise-valid entry are preserved as-is.
export function parseLedgerLines(raw: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip a corrupt/half-written line rather than fail the whole read
    }
    // A syntactically valid but non-object line (`null`, a bare number/string, an
    // array) is not an entry. Drop it here so downstream readers never deref a
    // primitive — `null` in particular would crash readLedger's `entry.beadId`.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    out.push(parsed as LedgerEntry);
  }
  return out;
}

// Map a decision-grade LoggedEvent to its LedgerEntry envelope. Lifts the
// envelope fields (ts, kshetra, beadId, runId, type) out and folds the rest of
// the event into `payload`, so the entry carries the decision without the caller
// re-specifying the correlation keys. Every decision-grade kind's shape includes
// `beadId`, so it is always present here. The source event's own `schemaVersion`
// (the activity-log version) is dropped in favour of LEDGER_SCHEMA_VERSION — the
// ledger versions independently.
export function toLedgerEntry(ev: LoggedEvent): LedgerEntry {
  const {
    ts,
    kshetra,
    runId,
    lotId,
    type,
    schemaVersion: _activityVersion,
    beadId,
    ...payload
  } = ev as LoggedEvent & { beadId?: string };
  return {
    ts,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    kshetra,
    // Most decision-grade kinds carry a beadId; the lot manifest (worker_started,
    // epic yrk) does not — it is lot-level. Default to '' so LedgerEntry.beadId
    // stays a required string and a bead query simply never matches it.
    beadId: beadId ?? '',
    ...(runId ? { runId } : {}),
    ...(lotId ? { lotId } : {}),
    kind: type,
    payload,
  };
}

// Compile-time exhaustiveness helper: reaching this at runtime means a union
// member went unhandled by a switch above. Its `never` parameter is what turns an
// unclassified new kind into a type error at the call site.
function assertNever(x: never): never {
  throw new Error(`unclassified ledger event kind: ${JSON.stringify(x)}`);
}
