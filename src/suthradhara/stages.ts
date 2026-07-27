// The phased interview (ARD §4). The stages are a rubric the model advances
// through and may revisit, not a one-way wizard — clarification reopens
// discovery, design exposes a missing requirement. This file owns the per-stage
// metadata that steers the prompt (prompt.ts) and the single hard gate: you may
// not enter a stage at or past `decompose` until the readiness rubric is met.
// state.ts owns the STAGES order and the SuthradharaStage type.

import type { SuthradharaStage, SessionState } from './state';
import { STAGES } from './state';
import { isReadyToDecompose, rubricStatus } from './rubric';

export interface StageMeta {
  // The perspective the model argues from in this stage (§4 table "Hat").
  hat: string;
  // What the stage is for.
  purpose: string;
  // The condition that says the stage's work is done.
  exit: string;
}

export const STAGE_META: Record<SuthradharaStage, StageMeta> = {
  discovery: {
    hat: 'Product',
    purpose:
      'Capture the raw idea: intent, the user and their problem, the "why now", rough success criteria. Detect whether this is a new feature or a change to an existing one.',
    exit:
      'The problem and desired outcome are stated in the operator\'s own words and reflected back.',
  },
  clarify: {
    hat: 'Product → Technical',
    purpose:
      'Active interview: resolve ambiguity, enumerate edge cases, non-functional requirements, explicit in/out of scope, priorities, and constraints.',
    exit:
      'The readiness rubric (§4.1) is satisfied; open questions are answered or explicitly deferred.',
  },
  decompose: {
    hat: 'Technical',
    purpose:
      'Grounded in the repo, break the feature into a parent epic + child beads with acceptance criteria, each sized for one Silpi ↔ Viharapala pass, ordered by dependency.',
    exit:
      'Every child has a title, description, acceptance criteria, priority; dependencies are drawn; nothing is left as "and then figure out X".',
  },
  design: {
    hat: 'Technical',
    purpose:
      'Synthesise the decisions into a design/arch note: chosen approach, key components and their touch-points in the existing code, alternatives considered, risks.',
    exit:
      'The note explains why the decomposition looks the way it does, referencing real files.',
  },
  confirm: {
    hat: '—',
    purpose:
      'Present the full bundle (design note + epic + children + dependency edges); the operator confirms, edits, or cancels.',
    exit:
      'Operator sends an explicit confirm frame, at which point the server files the epic + children + dependency edges. Edit reopens the interview; cancel discards.',
  },
};

// The first stage that involves proposing a decomposition. Entering it — or any
// stage past it — is gated on the readiness rubric.
const GATED_FROM = STAGES.indexOf('decompose');

export function stageIndex(stage: SuthradharaStage): number {
  return STAGES.indexOf(stage);
}

export function isGatedStage(stage: SuthradharaStage): boolean {
  return stageIndex(stage) >= GATED_FROM;
}

// The stage after `stage`, or null if already at the last (`confirm`).
export function nextStage(stage: SuthradharaStage): SuthradharaStage | null {
  const i = stageIndex(stage);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

export type EnterStageResult =
  | { ok: true; state: SessionState }
  | { ok: false; reason: string; missing: (keyof SessionState['rubric'])[] };

// Move the interview to `target`. Advancing into (or past) `decompose` is
// refused while any rubric item is unchecked — this is the "refuse to advance to
// a decomposition proposal while rubric items are unchecked" guarantee. Moving
// to a stage at or before `clarify` is always allowed, so the model can revisit
// discovery mid-clarify without a gate.
export function tryEnterStage(
  state: SessionState,
  target: SuthradharaStage,
): EnterStageResult {
  if (isGatedStage(target) && !isReadyToDecompose(state)) {
    const missing = rubricStatus(state).missing;
    return {
      ok: false,
      reason:
        `Cannot enter the "${target}" stage: the readiness rubric is not satisfied. ` +
        `Still needed: ${missing.join(', ')}. ` +
        'Answer or defer each item first (ask "are we ready?" to see the rubric).',
      missing,
    };
  }
  return { ok: true, state: { ...state, stage: target } };
}

// Advance one stage forward, gated the same way. Returns a refusal at the last
// stage or when the gate blocks the move.
export function tryAdvanceStage(state: SessionState): EnterStageResult {
  const next = nextStage(state.stage);
  if (next === null) {
    return {
      ok: false,
      reason: `Already at the final stage ("${state.stage}"); nothing to advance to.`,
      missing: [],
    };
  }
  return tryEnterStage(state, next);
}
