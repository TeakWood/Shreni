// The readiness rubric (ARD §4.1) — the gate between "talking" and proposing a
// decomposition. state.ts owns the RubricState shape; this file owns the logic:
// what a check means, how a deferral is recorded, whether the interview is ready
// to leave the clarify stage, and how the rubric renders when the operator asks
// "are we ready?".
//
// Two invariants encode xa0.2's acceptance criteria:
//   1. A genuine check (checkRubricItem) and a deferral (deferRubricItem) BOTH
//      satisfy an item for the purpose of the ready gate — a deferred item is
//      "recorded as an open question, not a blocker" (§4.1 "deferred (Qn)").
//   2. The deferral is distinguishable from a real check at render time, because
//      it carries a linked open question, so "are we ready?" shows what's still
//      soft. We derive that link from openQuestions rather than widening
//      RubricState, keeping the boolean rubric a pure satisfied/unsatisfied view.

import type { RubricState, SessionState, OpenQuestion } from './state';
import { RUBRIC_KEYS } from './state';

// Human-facing labels for each rubric item, lifted from the ARD §4.1 checklist.
// Used by the "are we ready?" render and injected into the stage-aware prompt so
// the model and the operator see the same wording.
export const RUBRIC_LABELS: Record<keyof RubricState, string> = {
  intent:
    'Intent — the problem and desired outcome are stated, not just a feature name.',
  usersStories:
    'Users / stories — who benefits and the concrete scenarios.',
  successCriteria:
    'Success criteria — observable, testable definition of done for the feature.',
  scopeBoundary:
    'Scope boundary — an explicit out-of-scope list, not only in-scope.',
  nonFunctional:
    'Non-functional — perf/security/UX/compat constraints that apply, or an explicit "none".',
  dependenciesUnknowns:
    'Dependencies / unknowns — external systems, prerequisite work, and any deferred questions named.',
};

export interface RubricStatus {
  // Items whose evidence has been captured or explicitly deferred.
  satisfied: (keyof RubricState)[];
  // Items still blocking a decomposition proposal.
  missing: (keyof RubricState)[];
  // The subset of `satisfied` that was deferred rather than genuinely answered —
  // each has a linked open question surfaced in the proposal.
  deferred: (keyof RubricState)[];
  // No missing items — the interview may advance to a decomposition proposal.
  ready: boolean;
}

// An item is "deferred" (as opposed to genuinely checked) when it is marked
// satisfied AND an open question is linked back to it. The link is what lets the
// eventual proposal carry the question forward instead of pretending the item
// was fully answered.
function deferredKeys(state: SessionState): Set<keyof RubricState> {
  const keys = new Set<keyof RubricState>();
  for (const q of state.openQuestions) {
    if (q.rubricKey && state.rubric[q.rubricKey]) keys.add(q.rubricKey);
  }
  return keys;
}

export function rubricStatus(state: SessionState): RubricStatus {
  const deferred = deferredKeys(state);
  const satisfied: (keyof RubricState)[] = [];
  const missing: (keyof RubricState)[] = [];
  for (const key of RUBRIC_KEYS) {
    if (state.rubric[key]) satisfied.push(key);
    else missing.push(key);
  }
  return {
    satisfied,
    missing,
    deferred: satisfied.filter(k => deferred.has(k)),
    ready: missing.length === 0,
  };
}

// The single gate xa0.2 enforces: the interview may not move to a decomposition
// proposal until every rubric item is satisfied (checked or deferred).
export function isReadyToDecompose(state: SessionState): boolean {
  return rubricStatus(state).ready;
}

// Immutable update — every mutation returns a fresh SessionState so the runner
// can hand the result straight to saveSession without worrying about aliasing
// the loaded object.
function withRubric(state: SessionState, patch: Partial<RubricState>): SessionState {
  return { ...state, rubric: { ...state.rubric, ...patch } };
}

// Mark an item satisfied because its evidence was captured in conversation.
export function checkRubricItem(
  state: SessionState,
  key: keyof RubricState,
): SessionState {
  return withRubric(state, { [key]: true });
}

// Open-question ids are Q1, Q2, … so the operator and the design note can refer
// to a deferral as "deferred (Q3)" exactly as the ARD writes it. Numbered by
// position so ids stay stable across a resume (openQuestions never reorder).
export function nextQuestionId(state: SessionState): string {
  return `Q${state.openQuestions.length + 1}`;
}

function appendQuestion(state: SessionState, q: OpenQuestion): SessionState {
  return { ...state, openQuestions: [...state.openQuestions, q] };
}

// Defer a rubric item: satisfy it for the gate but record the unresolved
// question so it is carried into the proposal rather than silently dropped.
// This is the "deferred (Qn)" path — the item stops blocking, the question does
// not disappear.
export function deferRubricItem(
  state: SessionState,
  key: keyof RubricState,
  question: string,
  now: string = new Date().toISOString(),
): SessionState {
  const q: OpenQuestion = {
    id: nextQuestionId(state),
    question,
    raisedAt: now,
    rubricKey: key,
  };
  return checkRubricItem(appendQuestion(state, q), key);
}

// A standalone open question not tied to any rubric item (e.g. an unknown
// surfaced under dependencies that doesn't map to a single checklist row).
export function addOpenQuestion(
  state: SessionState,
  question: string,
  now: string = new Date().toISOString(),
): SessionState {
  return appendQuestion(state, {
    id: nextQuestionId(state),
    question,
    raisedAt: now,
  });
}

// Render the rubric for the "are we ready?" answer (§4.1 design rule). One line
// per item: [x] checked, [~] deferred (with its question id), [ ] missing.
export function renderRubric(state: SessionState): string {
  const status = rubricStatus(state);
  const deferred = new Set(status.deferred);
  const qByKey = new Map<keyof RubricState, OpenQuestion>();
  for (const q of state.openQuestions) {
    if (q.rubricKey && !qByKey.has(q.rubricKey)) qByKey.set(q.rubricKey, q);
  }

  const header = status.ready
    ? `Readiness rubric — ${status.satisfied.length}/${RUBRIC_KEYS.length} satisfied (ready to propose a decomposition)`
    : `Readiness rubric — ${status.satisfied.length}/${RUBRIC_KEYS.length} satisfied (NOT ready — ${status.missing.length} item(s) still needed)`;

  const lines = RUBRIC_KEYS.map(key => {
    const label = RUBRIC_LABELS[key];
    if (deferred.has(key)) {
      const q = qByKey.get(key);
      return `  [~] ${label} — deferred (${q?.id ?? 'Q?'})`;
    }
    if (state.rubric[key]) return `  [x] ${label}`;
    return `  [ ] ${label}`;
  });

  return [header, ...lines].join('\n');
}

// Cheap detector for the operator asking about readiness, so the runner can
// deterministically inject renderRubric() regardless of how the model would
// otherwise respond. Matches "are we ready", a bare "ready?", or an explicit
// mention of the rubric/checklist.
const READINESS_QUERY_RE =
  /\b(are we ready|is it ready|ready to (?:decompose|file|propose)|show (?:the )?rubric|readiness|checklist)\b|^\s*ready\s*\?/i;

export function isReadinessQuery(text: string): boolean {
  return READINESS_QUERY_RE.test(text.trim());
}
