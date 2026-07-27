// The interview turn loop (ARD §9.2, §11, bead xa0.11) — the driver that was
// missing: `buildInterviewSpawn` had no non-test caller and the runner only
// idled. `runInterviewTurn` folds ONE operator exchange into the session:
//
//   1. record the operator's message on the transcript (Layer-1 audit);
//   2. if a proposal is pending and the message is a confirm/edit/cancel frame,
//      route it through the confirm gate (confirm.ts) — a clean confirm commits
//      the bundle via the injected CommitFn (commit.ts → filing + session bead);
//   3. otherwise spawn a stage-aware read-only `claude` turn (session.ts +
//      prompt.ts), capture the reply + the model-emitted state delta, DISTIL the
//      delta into requirements/rubric/open-questions/stage/pending (distill.ts),
//      record the assistant reply, and saveSession.
//
// CONTEXT ASSEMBLY (§9.2). The per-turn context is the DISTILLED state rendered
// by buildSystemPrompt — stage + rubric + requirements + open questions + pending
// proposal — NOT the verbatim transcript. The raw transcript is persisted for
// audit and resume continuity but is never spliced into the system prompt. An
// optional short last-N-turn window rides on the USER prompt purely for local
// conversational continuity; it is a convenience, not the memory — the distilled
// ledger is authoritative, and turning the window off (recentWindow: 0) leaves a
// fully faithful interview.
//
// FAITHFULNESS (the load-bearing invariant). Distillation happens BEFORE save
// every turn, so a requirement stated or a rubric item satisfied this turn lands
// in state and therefore in the NEXT turn's rendered prompt — the distilled state
// is summarising the conversation, not merely storing a transcript. Because the
// ledger is monotonic (distill.ts), a settled decision is written once and never
// re-emitted or re-litigated.

import type { KshetraConfig } from '../kshetra/config';
import type { SessionState } from './state';
import { buildInterviewSpawn } from './session';
import { recordUserTurn, recordAssistantTurn } from './interview';
import { parseConfirmFrame, hasPendingProposal, applyConfirmFrame } from './confirm';
import { parseTurnOutput, applyDelta } from './distill';
import type { CaptureFn } from './capture';
import type { CommitFn, CommitReport } from './commit';
import {
  classifyMatches,
  evolveStateFromOutcome,
  renderCandidateChoice,
  resolveCandidateChoice,
  type LocatedDoc,
} from './evolve';

// Locate an existing feature's design doc(s) for evolve-in-place (§8.1, evolve.ts).
// Returns matches ranked strongest-first; the turn loop classifies + folds them.
export type LocateFn = (feature: string) => Promise<LocatedDoc[]>;

export interface TurnDeps {
  // Spawn the interview turn and return the model's final assistant text.
  capture: CaptureFn;
  // Commit a confirmed bundle (filing + session bead). Only ever called after a
  // clean confirm frame clears a pending proposal.
  commit: CommitFn;
  // Persist the folded state (saveSession in production).
  save: (state: SessionState) => void;
  // Locate an existing feature's doc when the model emits `locateFeature` (§8.1).
  // Optional — absent it, an evolve signal is a no-op (a new-doc interview).
  locate?: LocateFn;
  // Clock injection for deterministic tests.
  now?: () => string;
  // How many prior transcript entries to include as a verbatim continuity window
  // on the USER prompt (never the system prompt). 0 disables it. Default 4.
  recentWindow?: number;
}

export interface TurnResult {
  state: SessionState;
  // The human-visible assistant reply (delta block stripped) or the server's
  // confirm/edit/cancel acknowledgement.
  reply: string;
  // Set when this turn committed a confirmed bundle.
  committed?: CommitReport;
  // Non-fatal distillation notes (dropped delta fields, a refused stage jump).
  warnings: string[];
}

const DEFAULT_WINDOW = 4;

// The last-N transcript entries rendered as a short continuity block for the USER
// prompt. Deliberately compact and clearly labelled so it reads as "recent
// exchange", not as the authoritative context. Empty string when the window is
// off or there is no prior transcript.
export function renderRecentWindow(state: SessionState, n: number): string {
  if (n <= 0 || state.transcript.length === 0) return '';
  const recent = state.transcript.slice(-n);
  const lines = recent.map(e => `${e.role === 'user' ? 'Operator' : 'You'}: ${e.content}`);
  return `Recent exchange (for continuity only — the authoritative state is in the system prompt):\n${lines.join('\n')}`;
}

// Compose the user prompt handed to the spawn: the optional continuity window
// (built from the transcript BEFORE this turn's message) followed by the operator
// message. The window lives here on the user prompt, never in buildSystemPrompt.
function composeUserPrompt(priorState: SessionState, message: string, n: number): string {
  const window = renderRecentWindow(priorState, n);
  return window ? `${window}\n\n---\n\nOperator: ${message}` : message;
}

// Fold one operator message into the session. Pure of I/O except through the
// injected deps (capture/commit/save), so the whole loop is testable without a
// process or a database.
export async function runInterviewTurn(
  state: SessionState,
  kshetra: KshetraConfig,
  message: string,
  deps: TurnDeps,
): Promise<TurnResult> {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const windowN = deps.recentWindow ?? DEFAULT_WINDOW;

  // The continuity window is built from the transcript as it stood BEFORE this
  // message, so the operator's current line isn't echoed back to the model.
  const userPrompt = composeUserPrompt(state, message, windowN);

  // Record the operator turn first — it is on the transcript regardless of which
  // branch handles the message.
  let next = recordUserTurn(state, message, now);

  // ── evolve doc-choice gate (§8.1) ───────────────────────────────────────────
  // When >1 doc matched, the interview parked candidates and asked which to
  // evolve. This message is the operator's answer — resolve it before anything
  // else (no proposal can be pending yet, since the prompt withholds proposing
  // until the target is chosen).
  if (awaitingDocChoice(next)) {
    const resolved = await resolveDocChoice(next, message, deps, now);
    if (resolved) {
      next = recordAssistantTurn(resolved.state, resolved.reply, now);
      deps.save(next);
      return { state: next, reply: resolved.reply, warnings: [] };
    }
    // Fall through: the message wasn't a recognizable choice — treat it as an
    // ordinary interview turn (the model can re-ask), leaving candidates intact.
  }

  // ── confirm gate ──────────────────────────────────────────────────────────
  // Only while a proposal is pending does a confirm/edit/cancel frame mean
  // anything; outside that window the message is an ordinary interview turn.
  if (hasPendingProposal(next)) {
    const frame = parseConfirmFrame(message);
    if (frame !== null) {
      const outcome = applyConfirmFrame(next, frame);

      if (outcome.outcome === 'confirmed') {
        // Commit `next` (which still holds `pending` + its doc body) — NOT
        // outcome.state, whose pending was cleared by applyConfirmFrame. On full
        // success executeCommit clears pending; on partial failure it keeps
        // pending and records the session bead so a re-confirm resumes (§7, Q2).
        const done = await executeCommit(next, kshetra, deps, now);
        next = recordAssistantTurn(done.state, done.reply, now);
        deps.save(next);
        return { state: next, reply: done.reply, committed: done.report, warnings: [] };
      }
      if (outcome.outcome === 'reopened') {
        const reply = 'Proposal set aside — the interview is reopened so we can revise it. Tell me what to change.';
        // Drop any in-flight commit marker: a revised proposal is a new bundle.
        next = recordAssistantTurn({ ...outcome.state, commit: null }, reply, now);
        deps.save(next);
        return { state: next, reply, warnings: [] };
      }
      if (outcome.outcome === 'discarded') {
        const reply = 'Proposal discarded. Nothing was filed. We can start a new decomposition when you are ready.';
        next = recordAssistantTurn({ ...outcome.state, commit: null }, reply, now);
        deps.save(next);
        return { state: next, reply, warnings: [] };
      }
      // 'noop' cannot happen here (pending was present); fall through defensively.
    }
  }

  // ── ordinary interview turn ─────────────────────────────────────────────────
  const spec = buildInterviewSpawn(next, kshetra, userPrompt);
  const raw = await deps.capture(spec);
  const { reply, delta } = parseTurnOutput(raw);

  let warnings: string[] = [];
  if (delta) {
    const applied = applyDelta(next, delta, now);
    next = applied.state;
    warnings = applied.warnings;
  }

  // ── evolve locate (§8.1) ────────────────────────────────────────────────────
  // The model detected a change to an existing feature and named it. Locate the
  // feature's doc(s) and fold the outcome into `state.evolving`, appending a
  // server note to the reply so the operator sees what was found. Skipped when a
  // target is already chosen for this same feature (locate runs once per feature).
  let replyOut = reply;
  if (delta?.locateFeature && deps.locate) {
    const located = await runLocate(next, delta.locateFeature, deps, now);
    next = located.state;
    if (located.note) replyOut = replyOut ? `${replyOut}\n\n${located.note}` : located.note;
  }

  // Record the delta-stripped reply so the operator/transcript never see the
  // control payload, then persist the distilled + transcript state.
  next = recordAssistantTurn(next, replyOut, now);
  deps.save(next);
  return { state: next, reply: replyOut, warnings };
}

// Whether the interview is waiting for the operator to pick which doc to evolve.
function awaitingDocChoice(state: SessionState): boolean {
  const ev = state.evolving;
  return !!ev && !!ev.candidates && ev.candidates.length > 0 && !ev.targetRelPath;
}

// Resolve the operator's doc-choice reply. Returns the new state + an
// acknowledgement, or null when the reply didn't map to any option (let the turn
// fall through to an ordinary interview turn). Re-locates to fetch the chosen
// doc's current body so the next prompt reconciles against it.
async function resolveDocChoice(
  state: SessionState,
  message: string,
  deps: TurnDeps,
  now: string,
): Promise<{ state: SessionState; reply: string } | null> {
  const ev = state.evolving!;
  const candidates = ev.candidates!;
  const { chosen } = resolveCandidateChoice(candidates, message);

  if (chosen === undefined) {
    // Not a recognizable choice — re-ask, keeping candidates parked.
    return null;
  }
  if (chosen === null) {
    // "None of these" — drop the evolve context; this becomes a new-doc interview.
    return {
      state: { ...state, evolving: null },
      reply: 'Understood — I will create a NEW design doc for this rather than evolving an existing one.',
    };
  }

  // Chosen an existing doc: re-locate to fetch its current content (candidates
  // stored only paths). Fall back to a content-less target if the re-locate can't
  // find it — the target path is what makes the commit update in place.
  let content = '';
  if (deps.locate && ev.feature) {
    try {
      const matches = await deps.locate(ev.feature);
      content = matches.find((m) => m.relPath === chosen)?.content ?? '';
    } catch {
      content = '';
    }
  }
  return {
    state: {
      ...state,
      evolving: { feature: ev.feature, targetRelPath: chosen, targetContent: content, locatedAt: now },
    },
    reply: `Evolving the existing design doc in place: ${chosen}. Tell me what changes.`,
  };
}

// Run the locator for a feature and fold the classified outcome into
// state.evolving. Returns the new state and an operator-facing note describing
// what was found (loaded one / asking which / none → will create).
async function runLocate(
  state: SessionState,
  feature: string,
  deps: TurnDeps,
  now: string,
): Promise<{ state: SessionState; note: string }> {
  // Locate once per feature: if a target for this feature is already chosen, keep it.
  if (state.evolving?.targetRelPath && state.evolving.feature === feature) {
    return { state, note: '' };
  }
  let matches: LocatedDoc[];
  try {
    matches = await deps.locate!(feature);
  } catch {
    return { state, note: '' };
  }

  const outcome = classifyMatches(matches);
  const evolving = evolveStateFromOutcome(feature, outcome, now);
  const nextState: SessionState = { ...state, evolving };

  if (outcome.kind === 'one') {
    return {
      state: nextState,
      note: `(Found an existing design doc for "${feature}" — ${outcome.doc.relPath}. I will evolve it in place rather than create a new one.)`,
    };
  }
  if (outcome.kind === 'many') {
    return { state: nextState, note: renderCandidateChoice(outcome.docs) };
  }
  return {
    state: nextState,
    note: `(No existing design doc found for "${feature}" — I will create a new one.)`,
  };
}

// Run the confirmed commit for a state whose `pending` proposal is set, and fold
// the outcome back into that state. Shared by the confirm branch and the
// resume-on-startup path so both handle success/partial-failure identically:
//   • full success → clear `pending` and the in-flight `commit` marker (the
//     bundle is filed, nothing left to resume);
//   • partial failure → KEEP `pending` (so a re-confirm re-drives it) and record
//     the session bead id in `commit` so the retry reconciles against the SAME
//     bead (§7, Q2) instead of filing a second bundle.
// `state.commit` (when already set from a prior partial attempt) is passed as the
// resume handle, so the very first partial failure and every retry share one bead.
async function executeCommit(
  state: SessionState,
  kshetra: KshetraConfig,
  deps: TurnDeps,
  now: string,
): Promise<{ state: SessionState; reply: string; report: CommitReport }> {
  const pending = state.pending!;
  const doc = pending.docContent ? { content: pending.docContent } : undefined;
  const report = await deps.commit({
    kshetra,
    decomposition: pending.decomposition,
    doc,
    evolving: state.evolving,
    resume: state.commit ?? undefined,
  });
  const reply = renderCommitReply(report);
  const nextState: SessionState = report.ok
    ? { ...state, pending: null, commit: null }
    : {
        ...state,
        commit: report.sessionBeadId ? { sessionBeadId: report.sessionBeadId } : state.commit,
      };
  return { state: nextState, reply, report };
}

// Resume an interrupted commit on session startup (§7, Q2). A prior turn confirmed
// a bundle whose commit only partially landed; the session persisted `pending` +
// an in-flight `commit` marker. Reconcile against the SAME session bead and file
// the remainder WITHOUT waiting for the operator to re-confirm. Returns null when
// there is nothing to resume (no in-flight commit), so the runner can call it
// unconditionally on load. Records an assistant turn describing the outcome.
export async function resumeInterruptedCommit(
  state: SessionState,
  kshetra: KshetraConfig,
  deps: TurnDeps,
): Promise<TurnResult | null> {
  if (!state.commit || !state.pending) return null;
  const now = deps.now ? deps.now() : new Date().toISOString();
  const done = await executeCommit(state, kshetra, deps, now);
  const next = recordAssistantTurn(done.state, done.reply, now);
  deps.save(next);
  return { state: next, reply: done.reply, committed: done.report, warnings: [] };
}

function renderCommitReply(report: CommitReport): string {
  if (report.ok) {
    const childCount = Object.keys(report.childIds).length;
    return [
      'Filed the bundle:',
      report.epicId ? `  epic ${report.epicId}` : undefined,
      `  ${childCount} child bead(s): ${Object.values(report.childIds).join(', ') || '(none)'}`,
      report.depsAdded.length ? `  ${report.depsAdded.length} dependency edge(s)` : undefined,
      report.docRelPath ? `  design doc: ${report.docRelPath}` : undefined,
      report.sessionBeadId ? `  session bead: ${report.sessionBeadId}` : undefined,
    ].filter(Boolean).join('\n');
  }
  return [
    'Commit did not fully complete — partial state:',
    report.epicId ? `  epic ${report.epicId}` : '  epic: not filed',
    `  children filed: ${Object.values(report.childIds).join(', ') || '(none)'}`,
    report.depsAdded.length ? `  deps added: ${report.depsAdded.length}` : '  deps added: 0',
    ...report.errors.map(e => `  ! ${e}`),
    'Re-confirm to resume — already-filed items are not re-filed.',
  ].join('\n');
}
