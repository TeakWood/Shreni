import type { KshetraConfig } from '../kshetra/config.js';
import type { PrStatus, PrReview, PrCheck, PrCommit } from './gh.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';
import { bd } from './beads.js';
import { runSilpi, adaptPrReview } from '../agents/silpi.js';
import { runViharapala } from '../agents/viharapala.js';
import { buildAgentContext } from './dispatch.js';
import { branchName } from './branch.js';
import { AgentAbortedError } from './errors.js';

// Label stamped on an awaiting-merge bead whose OPEN PR has unaddressed feedback.
// Detection (hjw.5) stamps it on the 5-min reconcile pass; selection picks it
// ahead of `bd ready` so in-flight PRs finish before new WIP starts. Distinct
// from AWAITING_MERGE_LABEL, which stays on the bead throughout — this label is
// added when there is work to do and removed once a follow-up round lands.
export const PR_NEEDS_FOLLOWUP_LABEL = 'pr-needs-followup';

// Check conclusions that count as "failing" for a required check. gh reports a
// CheckRun conclusion or a StatusContext state (normalised in gh.ts); a null
// conclusion means still running (pending) and is NOT a failure. SUCCESS /
// NEUTRAL / SKIPPED pass.
const FAILING_CONCLUSIONS = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);

// Resolve whether the PR follow-up loop is active. SHRENI_PR_FOLLOWUP=off is a
// runtime kill-switch (D7) that overrides the per-repo config; otherwise the
// Kshetra's repo.prFollowup decides (on by default).
export function resolvePrFollowup(kshetra: KshetraConfig): boolean {
  if (process.env.SHRENI_PR_FOLLOWUP === 'off') return false;
  return kshetra.repo.prFollowup;
}

// Idempotency watermark, persisted as bd notes on the awaiting-merge bead so it
// survives worker restarts (G6). `head` is the PR head sha last addressed, `at`
// the time we last pushed a follow-up, and `round` the number of rounds spent on
// the CURRENT feedback event. A new human review resets `round` (D8).
export interface PrWatermark {
  head: string | null;
  round: number;
  at: string | null;
}

// A note line carrying the watermark. Written verbatim by writeWatermark and
// recovered by parseWatermark, which reads the LAST occurrence of each key so an
// accumulated notes blob (bd concatenates notes) always yields the newest value.
const HEAD_RE = /pr-followup-head:(\S+)/gi;
const ROUND_RE = /pr-followup-round:(\d+)/gi;
const AT_RE = /pr-followup-at:(\S+)/gi;

function lastMatch(notes: string | undefined, re: RegExp): string | null {
  if (!notes) return null;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  re.lastIndex = 0;
  while ((m = re.exec(notes)) !== null) last = m[1];
  return last;
}

export function parseWatermark(notes: string | undefined): PrWatermark {
  const head = lastMatch(notes, HEAD_RE);
  const round = lastMatch(notes, ROUND_RE);
  const at = lastMatch(notes, AT_RE);
  return {
    head: head ?? null,
    round: round ? parseInt(round, 10) : 0,
    at: at ?? null,
  };
}

export function formatWatermark(w: PrWatermark): string {
  return `pr-followup-head:${w.head ?? ''} pr-followup-round:${w.round} pr-followup-at:${w.at ?? ''}`;
}

// Read the watermark off a bead's notes via `bd show --json`. Best-effort: any
// failure or absent notes yields a zeroed watermark (head/at null, round 0), so
// a bead that has never been followed up is treated as "everything is new".
export async function readWatermark(kshetra: KshetraConfig, beadId: string): Promise<PrWatermark> {
  try {
    const raw = await bd(kshetra).show(beadId);
    const parsed = JSON.parse(raw) as unknown;
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    const notes = (obj as { notes?: unknown } | null)?.notes;
    return parseWatermark(typeof notes === 'string' ? notes : undefined);
  } catch {
    return parseWatermark(undefined);
  }
}

// Persist the watermark as a bead note. Append-only (bd notes accumulate); the
// parse side always reads the latest, so re-writing is safe.
export function writeWatermark(kshetra: KshetraConfig, beadId: string, w: PrWatermark): Promise<string> {
  return bd(kshetra).addNote(beadId, formatWatermark(w));
}

export type PrTrigger = 'changes_requested' | 'failing_check' | 'foreign_commit';

// The unaddressed feedback on an OPEN PR, relative to the watermark. Returned by
// detectPrFeedback when there is anything to act on; null otherwise. `round` is
// the round index the follow-up loop should run as — reset to 0 on a new human
// review (D8), else carried forward from the watermark.
export interface PrFeedback {
  triggers: PrTrigger[];
  changesRequested: PrReview[];
  failingChecks: PrCheck[];
  foreignCommits: PrCommit[];
  round: number;
}

export interface DetectInput {
  status: PrStatus;
  watermark: PrWatermark;
  // gh logins that count as "us" — a commit by any other login is foreign.
  selfLogins: string[];
  // Names of the required checks (D9): only a failing REQUIRED check triggers a
  // round; advisory reds are ignored.
  requiredChecks: string[];
}

// True when `a` is strictly newer than the watermark time `b`. A null watermark
// (never addressed) makes everything new; a null review time is treated as new
// (we cannot prove it was already addressed) so feedback is never silently lost.
function isNewer(a: string | null, b: string | null): boolean {
  if (!b) return true;
  if (!a) return true;
  return a > b;
}

// Compute unaddressed feedback on an OPEN PR vs the bead's watermark. Pure — no
// bd/gh/git side effects; the caller (reconcile, hjw.5) supplies the status and
// watermark and acts on the result. Returns null when there is nothing new to do.
//
// Triggers (ARD D2):
//  • changes_requested — a CHANGES_REQUESTED review submitted after the last
//    follow-up (isNewer vs watermark.at); an unchanged review after our push is
//    NOT re-triggered.
//  • failing_check — a failing REQUIRED check on the current head; advisory reds
//    and pending checks are ignored.
//  • foreign_commit — the PR head moved to a commit authored by a non-self login
//    (someone pushed onto the branch); adopted by re-sync, not argued with.
export function detectPrFeedback(input: DetectInput): PrFeedback | null {
  const { status, watermark, selfLogins, requiredChecks } = input;
  const required = new Set(requiredChecks);
  const self = new Set(selfLogins);

  const changesRequested = status.reviews.filter(
    (r) => r.state === 'CHANGES_REQUESTED' && isNewer(r.submittedAt, watermark.at),
  );

  const failingChecks = status.checks.filter(
    (c) => required.has(c.name) && c.conclusion !== null && FAILING_CONCLUSIONS.has(c.conclusion),
  );

  // Foreign push: the tip moved to a commit we did not author. The tip is the
  // last entry (gh returns commits oldest-first). We only trigger when the tip
  // sha differs from the watermark head, so our own just-pushed follow-up (whose
  // sha we record) never re-triggers.
  const tip = status.commits.length ? status.commits[status.commits.length - 1] : null;
  const tipIsForeign =
    tip !== null &&
    tip.sha !== watermark.head &&
    tip.author !== null &&
    !self.has(tip.author);
  const foreignCommits = tipIsForeign
    ? status.commits.filter((c) => c.author !== null && !self.has(c.author) && c.sha !== watermark.head)
    : [];

  const triggers: PrTrigger[] = [];
  if (changesRequested.length) triggers.push('changes_requested');
  if (failingChecks.length) triggers.push('failing_check');
  if (foreignCommits.length) triggers.push('foreign_commit');

  if (triggers.length === 0) return null;

  // A new human review is a fresh feedback event — reset the round counter so the
  // reviewer always gets a full budget of fix passes (D8). A failing-check-only
  // or foreign-commit-only continuation carries the counter forward.
  const round = changesRequested.length ? 0 : watermark.round;

  return { triggers, changesRequested, failingChecks, foreignCommits, round };
}

// The bundle a follow-up round works from: the CHANGES_REQUESTED review to
// address, the failing required-check names + summaries (D9 Option A — the loop's
// LOCAL health gate supplies the detail, not CI logs), and startRound (the
// per-event round already spent, from the watermark via detectPrFeedback; 0 for a
// fresh human review).
export interface PrFollowupInput {
  review: PrReview;
  failingChecks: { name: string; summary: string }[];
  startRound: number;
}

export type PrFollowupOutcome = 'approved' | 'escalated' | 'exhausted';

// Outcome of a follow-up pass. `output` is the produced code + drafted replies
// FINALIZING acts on (push + prReply + watermark). Terminal states:
//  • approved  — re-review passed (or the gate is off): FINALIZING ships it.
//  • escalated — Silpi flagged a comment 'escalate': FINALIZING posts the other
//    replies, removes awaiting-merge, and flags a human.
//  • exhausted — the round budget ran out without approval: same human handoff.
export interface PrFollowupResult {
  outcome: PrFollowupOutcome;
  output: SilpiOutput | null;
  rounds: number;
  note: string;
}

// Bounded Silpi↔Viharapala pass over open-PR feedback (ARD §4.4), mirroring
// runSilpiViharapalaLoop but for a PR that is already open. PURE PRODUCER: it
// runs the agents (which make their own implementation commits) and returns what
// to do — it performs NO git/gh/bd-state side effects itself. Sthapathi's
// FINALIZING phase (hjw.5) owns push, prReply, watermark, and label changes.
//
// Each round: adapt the human review → Feedback → runSilpi (code + per-comment
// triage) → optional Viharapala re-review of the diff. An 'escalate' disposition
// short-circuits to a human; APPROVE ships; REJECT spends another round. The
// per-event budget is prFollowupMaxRounds (it resets on each new human review via
// detectPrFeedback, which sets startRound back to 0).
export async function runPrFollowupLoop(
  task: Task,
  kshetra: KshetraConfig,
  feedback: PrFollowupInput,
  signal?: AbortSignal,
): Promise<PrFollowupResult> {
  const branch = branchName(task);
  const prFeedback = adaptPrReview(feedback.review, feedback.failingChecks);
  const maxRounds = kshetra.repo.prFollowupMaxRounds;
  const reReview = kshetra.repo.prFollowupReReview;

  let round = feedback.startRound;
  let viharapalaFeedback: ViharapalaOutput | null = null;
  let lastOutput: SilpiOutput | null = null;

  // The budget for this feedback event was already spent (e.g. the reviewer
  // re-requested changes without a new review). Hand to a human rather than loop.
  if (round >= maxRounds) {
    return {
      outcome: 'exhausted',
      output: null,
      rounds: round,
      note: `Round budget (${maxRounds}) already spent for this feedback event`,
    };
  }

  while (round < maxRounds) {
    round++;
    if (signal?.aborted) throw new AgentAbortedError();

    const context = await buildAgentContext(kshetra, task);
    // prFeedback (the human review) rides every round so Silpi always re-emits
    // the per-comment triage; viharapalaFeedback carries a prior re-review reject.
    const silpiOut = await runSilpi(context, round, viharapalaFeedback, branch, signal, prFeedback);
    lastOutput = silpiOut;

    // Any 'escalate' disposition ends the pass — no amount of looping resolves a
    // comment that needs a human decision. FINALIZING still posts the other
    // replies; the escalate reasons ride in the returned output.
    const escalated = (silpiOut.commentResponses ?? []).filter((r) => r.disposition === 'escalate');
    if (escalated.length) {
      return {
        outcome: 'escalated',
        output: silpiOut,
        rounds: round,
        note: `Escalated ${escalated.length} comment(s) to a human`,
      };
    }

    // Re-review gate off (prFollowupReReview=false): ship the fix without a
    // Viharapala pass.
    if (!reReview) {
      return { outcome: 'approved', output: silpiOut, rounds: round, note: `Produced (no re-review gate), round ${round}` };
    }

    if (signal?.aborted) throw new AgentAbortedError();
    viharapalaFeedback = await runViharapala(context, silpiOut, round, context.taskDetails, branch, signal);
    if (viharapalaFeedback.verdict === 'APPROVE') {
      return { outcome: 'approved', output: silpiOut, rounds: round, note: `Approved by re-review, round ${round}` };
    }
    // REJECT — spend another round within the budget (the re-review gate blocked
    // a bad fix), feeding Viharapala's mustFix back to Silpi.
  }

  return {
    outcome: 'exhausted',
    output: lastOutput,
    rounds: round,
    note: `Exhausted ${maxRounds} round(s) without a passing re-review`,
  };
}
