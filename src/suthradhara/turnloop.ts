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

export interface TurnDeps {
  // Spawn the interview turn and return the model's final assistant text.
  capture: CaptureFn;
  // Commit a confirmed bundle (filing + session bead). Only ever called after a
  // clean confirm frame clears a pending proposal.
  commit: CommitFn;
  // Persist the folded state (saveSession in production).
  save: (state: SessionState) => void;
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

  // ── confirm gate ──────────────────────────────────────────────────────────
  // Only while a proposal is pending does a confirm/edit/cancel frame mean
  // anything; outside that window the message is an ordinary interview turn.
  if (hasPendingProposal(next)) {
    const frame = parseConfirmFrame(message);
    if (frame !== null) {
      // Grab the decomposition before applyConfirmFrame clears `pending` — the
      // commit needs it for the session-bead spine.
      const decomposition = next.pending?.decomposition;
      const outcome = applyConfirmFrame(next, frame);

      if (outcome.outcome === 'confirmed' && decomposition) {
        const report = await deps.commit({ kshetra, decomposition });
        const reply = renderCommitReply(report);
        next = recordAssistantTurn(outcome.state, reply, now);
        deps.save(next);
        return { state: next, reply, committed: report, warnings: [] };
      }
      if (outcome.outcome === 'reopened') {
        const reply = 'Proposal set aside — the interview is reopened so we can revise it. Tell me what to change.';
        next = recordAssistantTurn(outcome.state, reply, now);
        deps.save(next);
        return { state: next, reply, warnings: [] };
      }
      if (outcome.outcome === 'discarded') {
        const reply = 'Proposal discarded. Nothing was filed. We can start a new decomposition when you are ready.';
        next = recordAssistantTurn(outcome.state, reply, now);
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

  // Record the delta-stripped reply so the operator/transcript never see the
  // control payload, then persist the distilled + transcript state.
  next = recordAssistantTurn(next, reply, now);
  deps.save(next);
  return { state: next, reply, warnings };
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
