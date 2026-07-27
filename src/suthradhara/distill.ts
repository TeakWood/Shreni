// The distiller (ARD §9.2, §11) — the load-bearing half of "distilled state IS
// the conversation summary". Each interview turn the model emits, alongside its
// natural-language reply, an explicit STATE DELTA: the new settled facts of this
// turn (requirements to add, rubric keys now satisfied or deferred-with-question,
// new open questions, an optional stage advance, and — once ready — the
// structured decomposition proposal). This module owns three pure operations:
//
//   1. parseTurnOutput() — split the model's raw reply into the human-visible
//      text and the machine-readable delta, extracting the LAST `suthradhara-delta`
//      fenced JSON block. Fail-SAFE: a missing or malformed block yields a null
//      delta and the full text as the reply, never an exception — a bad turn
//      distils nothing rather than crashing the interview.
//   2. validateDelta() — narrow the untrusted JSON to a StateDelta, dropping
//      hallucinated rubric keys / stages with a warning rather than applying them.
//   3. applyDelta() — fold the validated delta into the session via the EXISTING
//      pure mutators (addRequirement / checkRubricItem / deferRubricItem /
//      addOpenQuestion / tryEnterStage / presentProposal), before saveSession.
//
// Q10 (resolved): extraction is model-emitted structured data — NOT a heuristic
// parse of the prose (brittle) and NOT a second summariser pass (extra cost). The
// ledger is MONOTONIC: the delta only ever ADDS settled facts or advances a
// stage, so every mutator here is either idempotent (checkRubricItem) or
// de-duplicating (addRequirement), and a decision written once thereafter simply
// IS — re-emitting it is a no-op, never a duplicate.

import type { SessionState, RubricState, SuthradharaStage } from './state';
import { RUBRIC_KEYS, STAGES } from './state';
import type { Decomposition } from './decomposition';
import {
  addRequirement,
  checkRubricItem,
  deferRubricItem,
  addOpenQuestion,
} from './interview';
import { tryEnterStage } from './stages';
import { presentProposal } from './confirm';

// The fenced code-block language tag the model wraps its per-turn delta in. A
// distinctive tag (not bare ```json) so the parser targets Suthradhara's own
// block and never mistakes an incidental JSON snippet in the prose for the delta.
export const DELTA_FENCE = 'suthradhara-delta';

// A rubric item deferred this turn: satisfied for the gate, but the unresolved
// question is carried forward (rubric.ts deferRubricItem → "deferred (Qn)").
export interface RubricDeferral {
  key: keyof RubricState;
  question: string;
}

// The model-emitted, per-turn state delta (§9.2). Every field is optional — a
// pure conversational turn that settled nothing emits `{}` (or omits the block).
// Only NEW facts appear; the monotonic ledger means a field never restates what
// distilled state already holds.
export interface StateDelta {
  // Converged requirement bullets to append (de-duplicated by addRequirement).
  requirements?: string[];
  // Rubric items whose evidence was captured this turn.
  checkRubric?: (keyof RubricState)[];
  // Rubric items the operator chose to defer, each with the question carried on.
  deferRubric?: RubricDeferral[];
  // Free-standing unknowns surfaced this turn (not tied to a rubric item).
  openQuestions?: string[];
  // A stage the model wants to advance into. Gated by tryEnterStage — a jump
  // past the readiness rubric is refused and reported, never silently applied.
  advanceStage?: SuthradharaStage;
  // The structured decomposition, emitted once the model reaches decompose/design
  // and is presenting a proposal. Held server-side via presentProposal (the
  // confirm gate); NOTHING is filed until an explicit confirm frame.
  proposal?: Decomposition;
}

// The result of splitting a turn's raw output: what to show/persist as the
// assistant's reply (delta block stripped), and the extracted delta (null if the
// model emitted none, or emitted an unparseable one).
export interface TurnOutput {
  reply: string;
  delta: StateDelta | null;
}

// Match every ```suthradhara-delta … ``` block; we keep the LAST one so a model
// that "thinks out loud" with an earlier draft block still has its final answer
// win. Non-greedy body, tolerant of trailing whitespace before the closing fence.
const DELTA_BLOCK_RE = new RegExp(
  '```' + DELTA_FENCE + '\\s*\\n([\\s\\S]*?)\\n```',
  'gi',
);

// Split the model's raw final text into the human reply and the machine delta.
// Pure and total: any parse failure degrades to { reply: <raw>, delta: null } so
// a malformed block never throws mid-interview. The delta block is stripped from
// the reply regardless of whether its JSON parsed, so the operator never sees the
// control payload.
export function parseTurnOutput(raw: string): TurnOutput {
  const matches = [...raw.matchAll(DELTA_BLOCK_RE)];
  if (matches.length === 0) {
    return { reply: raw.trim(), delta: null };
  }

  const last = matches[matches.length - 1];
  const body = last[1];

  // Strip every delta block from the visible reply (not just the last) — an
  // earlier draft block should not leak to the operator either.
  const reply = raw.replace(DELTA_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { reply, delta: null };
  }
  return { reply, delta: validateDelta(parsed).delta };
}

export interface ValidatedDelta {
  delta: StateDelta;
  // Fields the model emitted that were dropped as invalid (unknown rubric key,
  // unknown stage, wrong shape). Surfaced so the turn loop can log them — a
  // hallucinated key is ignored, not applied, but not silently either.
  warnings: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isRubricKey(v: unknown): v is keyof RubricState {
  return typeof v === 'string' && (RUBRIC_KEYS as readonly string[]).includes(v);
}

function isStage(v: unknown): v is SuthradharaStage {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v);
}

// Narrow untrusted JSON to a StateDelta, keeping only well-formed fields and
// recording every rejection. Never throws — an all-garbage payload yields an
// empty delta plus warnings. Proposal shape is NOT deep-validated here
// (validateDecomposition does that inside presentProposal); we only check it is
// an object so a non-object doesn't reach the confirm gate.
export function validateDelta(value: unknown): ValidatedDelta {
  const warnings: string[] = [];
  const delta: StateDelta = {};
  if (typeof value !== 'object' || value === null) {
    return { delta, warnings: ['delta is not an object; ignored'] };
  }
  const v = value as Record<string, unknown>;

  if (v.requirements !== undefined) {
    if (isStringArray(v.requirements)) delta.requirements = v.requirements;
    else warnings.push('requirements is not a string[]; ignored');
  }

  if (v.checkRubric !== undefined) {
    if (Array.isArray(v.checkRubric)) {
      const keys = v.checkRubric.filter(isRubricKey);
      for (const bad of v.checkRubric.filter(k => !isRubricKey(k))) {
        warnings.push(`checkRubric: unknown rubric key ${JSON.stringify(bad)}; ignored`);
      }
      if (keys.length) delta.checkRubric = keys;
    } else warnings.push('checkRubric is not an array; ignored');
  }

  if (v.deferRubric !== undefined) {
    if (Array.isArray(v.deferRubric)) {
      const defs: RubricDeferral[] = [];
      for (const d of v.deferRubric) {
        if (
          d && typeof d === 'object' &&
          isRubricKey((d as Record<string, unknown>).key) &&
          typeof (d as Record<string, unknown>).question === 'string'
        ) {
          const r = d as Record<string, unknown>;
          defs.push({ key: r.key as keyof RubricState, question: r.question as string });
        } else {
          warnings.push(`deferRubric: malformed entry ${JSON.stringify(d)}; ignored`);
        }
      }
      if (defs.length) delta.deferRubric = defs;
    } else warnings.push('deferRubric is not an array; ignored');
  }

  if (v.openQuestions !== undefined) {
    if (isStringArray(v.openQuestions)) delta.openQuestions = v.openQuestions;
    else warnings.push('openQuestions is not a string[]; ignored');
  }

  if (v.advanceStage !== undefined) {
    if (isStage(v.advanceStage)) delta.advanceStage = v.advanceStage;
    else warnings.push(`advanceStage: unknown stage ${JSON.stringify(v.advanceStage)}; ignored`);
  }

  if (v.proposal !== undefined) {
    if (v.proposal && typeof v.proposal === 'object') delta.proposal = v.proposal as Decomposition;
    else warnings.push('proposal is not an object; ignored');
  }

  return { delta, warnings };
}

export interface ApplyResult {
  state: SessionState;
  // Things the delta asked for that the server refused (a gated stage jump with
  // an unsatisfied rubric, an invalid proposal). Non-fatal — the rest of the
  // delta still applies; these surface to the operator/log.
  warnings: string[];
}

// Fold a validated delta into the session via the pure mutators, in a fixed
// order so requirements/rubric are captured BEFORE a stage advance is gated
// against them (a turn can satisfy the last rubric item AND advance in one go).
// The proposal is applied LAST: presentProposal validates the decomposition and,
// on success, holds it as `pending` for the confirm gate; a malformed proposal is
// refused with a warning and leaves no pending state. Every step returns fresh
// state (no aliasing) so the caller hands the result straight to saveSession.
export function applyDelta(
  state: SessionState,
  delta: StateDelta,
  now: string = new Date().toISOString(),
): ApplyResult {
  const warnings: string[] = [];
  let next = state;

  for (const req of delta.requirements ?? []) {
    next = addRequirement(next, req);
  }
  for (const key of delta.checkRubric ?? []) {
    next = checkRubricItem(next, key);
  }
  for (const def of delta.deferRubric ?? []) {
    next = deferRubricItem(next, def.key, def.question, now);
  }
  for (const q of delta.openQuestions ?? []) {
    next = addOpenQuestion(next, q, now);
  }

  if (delta.advanceStage !== undefined && delta.advanceStage !== next.stage) {
    const res = tryEnterStage(next, delta.advanceStage);
    if (res.ok) next = res.state;
    else warnings.push(res.reason);
  }

  if (delta.proposal !== undefined) {
    const res = presentProposal(next, delta.proposal, now);
    if (res.ok) next = res.state;
    else warnings.push(`Proposal not held (invalid): ${res.errors.join('; ')}`);
  }

  return { state: next, warnings };
}
