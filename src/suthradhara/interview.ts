// The interview engine's state-mutation surface — the functions a turn loop
// composes to fold one exchange into the session (ARD §4). Everything here is
// pure: take a SessionState, return a new one, hand it to saveSession. The
// rubric gate (rubric.ts) and stage machine (stages.ts) do the hard parts; this
// file is the thin facade over the transcript and running requirement set plus a
// re-export of the pieces a caller reaches for together.
//
// xa0.2 stops at "produces a proposal to copy-paste, files nothing": these
// helpers evolve the interview and gate the jump to decomposition, but nothing
// here writes a bead or a file. That surface arrives in xa0.4/xa0.5.

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
