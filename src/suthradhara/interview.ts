// The interview engine's state-mutation surface — the functions a turn loop
// composes to fold one exchange into the session (ARD §4). Everything here is
// pure: take a SessionState, return a new one, hand it to saveSession. The
// rubric gate (rubric.ts) and stage machine (stages.ts) do the hard parts; this
// file is the thin facade over the transcript and running requirement set plus a
// re-export of the pieces a caller reaches for together.
//
// The interview-evolution helpers here (transcript, requirements, rubric,
// stage gate) are still pure and file nothing. xa0.4 adds the filing surface
// alongside them — confirm.ts holds a proposal until an explicit confirm frame,
// decomposition.ts models/validates the proposal, and filing.ts compiles it to
// argv `bd` commands — all re-exported below so a turn loop reaches for one
// facade. A bead write is authorised ONLY by applyConfirmFrame returning
// `confirmed`; none of these functions writes on its own.

import type { SessionState, TranscriptEntry } from './state';

export {
  rubricStatus,
  isReadyToDecompose,
  checkRubricItem,
  deferRubricItem,
  addOpenQuestion,
  renderRubric,
  isReadinessQuery,
} from './rubric';

export {
  tryEnterStage,
  tryAdvanceStage,
  nextStage,
  STAGE_META,
} from './stages';

export {
  parseConfirmFrame,
  hasPendingProposal,
  presentProposal,
  applyConfirmFrame,
} from './confirm';
export type { ConfirmFrame, ConfirmOutcome, PresentResult } from './confirm';

export { validateDecomposition } from './decomposition';
export type {
  Decomposition,
  ProposedEpic,
  ProposedChild,
  ProposedDep,
  BeadType,
} from './decomposition';

export { compileFilingPlan, resolveStepArgv, UnresolvedRefError } from './filing';
export type { FilingPlan, FilingStep, CreateStep, DepStep } from './filing';

function recordTurn(
  state: SessionState,
  role: TranscriptEntry['role'],
  content: string,
  now: string,
): SessionState {
  const entry: TranscriptEntry = { role, content, at: now };
  return { ...state, transcript: [...state.transcript, entry] };
}

export function recordUserTurn(
  state: SessionState,
  content: string,
  now: string = new Date().toISOString(),
): SessionState {
  return recordTurn(state, 'user', content, now);
}

export function recordAssistantTurn(
  state: SessionState,
  content: string,
  now: string = new Date().toISOString(),
): SessionState {
  return recordTurn(state, 'assistant', content, now);
}

// Append a converged requirement bullet. De-duplicated on exact text so a turn
// that re-states an existing requirement doesn't pad the set — the interview
// amends the same list as clarity improves rather than accreting near-duplicates.
export function addRequirement(state: SessionState, text: string): SessionState {
  const trimmed = text.trim();
  if (trimmed === '' || state.requirements.includes(trimmed)) return state;
  return { ...state, requirements: [...state.requirements, trimmed] };
}

// Record the external source of record this interview was grounded in (pmb.7).
// Monotonic: the FIRST pull wins — once `source` is set, a later re-emit (of the
// same or a different ref) is a no-op, so the ticket is distilled exactly once and
// never re-fetched. An empty ref is ignored. Pure.
export function setSource(
  state: SessionState,
  ref: string,
  now: string = new Date().toISOString(),
): SessionState {
  const trimmed = ref.trim();
  if (trimmed === '' || state.source) return state;
  return { ...state, source: { ref: trimmed, pulledAt: now } };
}
