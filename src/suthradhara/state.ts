// Layer-1 session state (ARD §9): the chatty, unstructured, single-host shape
// Suthradhara persists to disk between turns and rehydrates on `resume`. Kept
// deliberately narrow — anything Sthapathi consumes lives in Layer-2 (the
// session bead, xa0.9). This file owns the schema; persistence.ts owns the I/O.
//
// xa0.2 fills in the actual interview loop: it mutates `stage`, ticks off
// rubric items as evidence accrues, appends to `requirements` / `openQuestions`
// / `transcript`, and hands the updated state back for save. xa0.3 only has to
// guarantee that shape survives round-tripping through JSON.

// The four interview phases from ARD §4. `confirm` is the final gate before
// writes and lives here so xa0.4 can advance into it without changing the type.
export type SuthradharaStage = 'discovery' | 'clarify' | 'decompose' | 'design' | 'confirm';

export const STAGES: readonly SuthradharaStage[] = [
  'discovery',
  'clarify',
  'decompose',
  'design',
  'confirm',
] as const;

// Readiness rubric items from ARD §4.1 / xa0.2's acceptance criteria. A key is
// `true` once its evidence has been captured; xa0.2 refuses to advance to a
// decomposition proposal while any item is `false`.
export interface RubricState {
  intent: boolean;
  usersStories: boolean;
  successCriteria: boolean;
  scopeBoundary: boolean;
  nonFunctional: boolean;
  dependenciesUnknowns: boolean;
}

export const RUBRIC_KEYS: readonly (keyof RubricState)[] = [
  'intent',
  'usersStories',
  'successCriteria',
  'scopeBoundary',
  'nonFunctional',
  'dependenciesUnknowns',
] as const;

export function emptyRubric(): RubricState {
  return {
    intent: false,
    usersStories: false,
    successCriteria: false,
    scopeBoundary: false,
    nonFunctional: false,
    dependenciesUnknowns: false,
  };
}

// One chat turn. `role` mirrors the claude-CLI transcript vocabulary so xa0.2
// can round-trip without translation. `at` is an ISO-8601 timestamp so a saved
// session sorts naturally and human-reads without post-processing.
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

// A rubric item the operator asked to defer (§4.1 "deferred(Qn)"). Recorded as
// an open question rather than a blocker so the interview can advance past it
// and the question surfaces in the eventual proposal.
export interface OpenQuestion {
  id: string;
  question: string;
  raisedAt: string;
  // When this question exists because a rubric item was deferred, the item it
  // stands in for. Absent for free-standing unknowns. Optional (additive), so
  // the on-disk schema version is unchanged — old sessions load fine.
  rubricKey?: keyof RubricState;
}

// A decomposition the model has proposed and presented, held server-side while
// the interview waits for the operator's confirm/edit/cancel (ARD §6.1, §7).
// Its mere presence is the "commit-bearing turn" flag: while `pending` is set,
// allowlistForTurn() unlocks the filing surface, and NOTHING is filed until a
// confirm frame clears it (confirm.ts). It persists in the session so a resume
// mid-gate still knows a proposal is awaiting confirmation rather than silently
// dropping it. Optional/additive — old sessions load with `pending` absent.
export interface PendingProposal {
  // The full decomposition object (decomposition.ts); kept structured, not
  // rendered text, so an "edit" can amend it in place.
  decomposition: import('./decomposition').Decomposition;
  // When it was presented to the operator (ISO-8601), for the audit trail.
  presentedAt: string;
}

// Evolve-in-place context (ARD §8.1, G9): set when the interview is a CHANGE to
// an existing feature, not a brand-new one. When the locator (evolve.ts) finds
// the feature's existing design doc, this carries the path to evolve IN PLACE and
// a content snapshot the prompt reconciles against — so the commit rewrites the
// SAME file (a diff), never a parallel doc. When >1 doc matched, `candidates`
// holds them while the interview asks the operator which to evolve; picking one
// sets `targetRelPath` and clears `candidates`. Optional/additive — old sessions
// load with `evolving` absent (a plain new-feature interview).
export interface EvolveState {
  // The feature name the locate ran for (the model's `locateFeature` signal).
  // Kept so a disambiguation choice can re-locate to fetch the chosen doc's body.
  feature?: string;
  // The chosen existing doc's repo-relative path, once resolved (a single match,
  // or the operator disambiguating). Absent while `candidates` awaits a choice.
  targetRelPath?: string;
  // A snapshot of the chosen doc's content at locate time, rendered into the
  // prompt so clarification is framed against the existing design (§8.1 step 2)
  // and the commit can diff against it (§8.1 step 3).
  targetContent?: string;
  // When more than one doc plausibly matched, the candidate repo-relative paths
  // awaiting the operator's choice — the interview asks rather than guessing
  // (§8.1 "more than one plausible match → asks which to evolve").
  candidates?: string[];
  // ISO-8601 timestamp of the locate that produced this context, for the audit
  // trail (a doc may have changed on disk since; the snapshot is as-of here).
  locatedAt: string;
}

// Bumped when the on-disk shape changes in a way that isn't a pure additive
// field. loadSession() rejects an unknown version rather than mis-hydrating.
export const SESSION_STATE_VERSION = 1 as const;

export interface SessionState {
  version: typeof SESSION_STATE_VERSION;
  id: string;
  kshetraId: string;
  createdAt: string;
  updatedAt: string;
  stage: SuthradharaStage;
  rubric: RubricState;
  // The running requirement set — free-text bullets the interview keeps
  // amending as clarity improves. Not a plan spine (that's Layer 2); just the
  // evolving text the operator and agent are converging on.
  requirements: string[];
  openQuestions: OpenQuestion[];
  transcript: TranscriptEntry[];
  // A decomposition proposal awaiting the operator's confirm/edit/cancel.
  // Absent whenever the interview is not at a confirm gate. See PendingProposal.
  pending?: PendingProposal | null;
  // Set when this interview evolves an EXISTING feature's doc in place (§8.1).
  // Absent for a brand-new feature (the §8 default: create a fresh doc). See
  // EvolveState.
  evolving?: EvolveState | null;
}

export function newSessionState(
  id: string,
  kshetraId: string,
  now: string = new Date().toISOString(),
): SessionState {
  return {
    version: SESSION_STATE_VERSION,
    id,
    kshetraId,
    createdAt: now,
    updatedAt: now,
    stage: 'discovery',
    rubric: emptyRubric(),
    requirements: [],
    openQuestions: [],
    transcript: [],
  };
}
