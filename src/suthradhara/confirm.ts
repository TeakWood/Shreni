// The server-side confirm gate (ARD §6.1, §7) — the reason a Suthradhara
// session can propose an epic without ever accidentally filing one. The server
// (the turn loop), not the model, is the authority: a proposal is HELD in the
// session (`pending`) and NOTHING is filed until the operator sends an explicit
// confirm frame. `edit` loops back to the interview so the model can revise and
// re-present; `cancel` discards the held proposal. Every path here is pure —
// it folds a frame into a new SessionState and, on confirm, hands back the
// filing plan for the server's post-confirm step to execute (filing.ts +
// xa0.6). It never spawns or runs `bd` itself.

import type { SessionState } from './state';
import type { Decomposition } from './decomposition';
import { validateDecomposition } from './decomposition';
import { compileFilingPlan, type FilingPlan } from './filing';

export type ConfirmFrame = 'confirm' | 'edit' | 'cancel';

// Deliberately conservative: only a CLEAN confirm files. If the operator's
// message mixes signals ("confirm but change the title"), or leans cancel/edit,
// we never treat it as a confirm — the authority errs toward not writing. So we
// test cancel first, then edit, then confirm, and a message matching an
// earlier, non-confirm category wins.
const CANCEL_RE = /\b(cancel|discard|abort|scrap|never ?mind|forget it|drop it|throw (?:it|this) away)\b/i;
const EDIT_RE = /\b(edit|change|revise|amend|adjust|modify|tweak|redo|rework|fix|not quite|not right|hold on)\b/i;
const CONFIRM_RE = /\b(confirm(?:ed)?|approve[ds]?|file it|file them|ship it|go ahead|lgtm|looks good)\b|^\s*yes\s*$/i;

// Classify an operator message as a confirm/edit/cancel frame, or null if it is
// neither (an ordinary interview turn). The server calls this only while a
// proposal is pending; outside that window the return value is irrelevant.
export function parseConfirmFrame(text: string): ConfirmFrame | null {
  const t = text.trim();
  if (CANCEL_RE.test(t)) return 'cancel';
  if (EDIT_RE.test(t)) return 'edit';
  if (CONFIRM_RE.test(t)) return 'confirm';
  return null;
}

export function hasPendingProposal(state: SessionState): boolean {
  return state.pending != null;
}

export type PresentResult =
  | { ok: true; state: SessionState }
  | { ok: false; errors: string[] };

// Present a decomposition to the operator: validate it, then HOLD it in the
// session awaiting confirmation. Files nothing. A proposal that would not file
// cleanly is refused here (before the operator is asked to confirm) so the gate
// never holds a malformed bundle. Overwrites any previously pending proposal —
// re-presenting after an edit replaces the old one.
export function presentProposal(
  state: SessionState,
  decomposition: Decomposition,
  now: string = new Date().toISOString(),
  docContent?: string,
): PresentResult {
  const validation = validateDecomposition(decomposition);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const trimmed = docContent?.trim();
  return {
    ok: true,
    state: {
      ...state,
      pending: {
        decomposition,
        // Keep the doc body only when non-empty — a blank note is exactly what
        // writeDesignDoc refuses, so we never hold one for the commit.
        ...(trimmed ? { docContent } : {}),
        presentedAt: now,
      },
    },
  };
}

export type ConfirmOutcome =
  // The operator confirmed: the proposal is cleared from the session and its
  // filing plan is handed back for the server to execute. This is the ONLY
  // outcome that authorises a bd write, and it is produced only from a held
  // proposal + an explicit confirm frame.
  | { outcome: 'confirmed'; state: SessionState; plan: FilingPlan }
  // The operator wants changes: the held proposal is dropped and the interview
  // reopens so the model can revise and call presentProposal again.
  | { outcome: 'reopened'; state: SessionState }
  // The operator cancelled: the held proposal is discarded, nothing filed.
  | { outcome: 'discarded'; state: SessionState }
  // There was nothing pending to act on — the frame is a no-op.
  | { outcome: 'noop'; state: SessionState };

// Fold a confirm frame into the session. The heart of "server is authority":
// a bd write is authorised ONLY by this function returning `confirmed`, which
// requires both a held proposal AND an explicit confirm frame. Any other frame,
// or no held proposal, leaves nothing filed.
export function applyConfirmFrame(
  state: SessionState,
  frame: ConfirmFrame,
): ConfirmOutcome {
  const pending = state.pending;
  if (pending == null) return { outcome: 'noop', state };

  const cleared: SessionState = { ...state, pending: null };

  switch (frame) {
    case 'confirm':
      return {
        outcome: 'confirmed',
        state: cleared,
        plan: compileFilingPlan(pending.decomposition, state.source?.ref ?? undefined),
      };
    case 'edit':
      return { outcome: 'reopened', state: cleared };
    case 'cancel':
      return { outcome: 'discarded', state: cleared };
  }
}
