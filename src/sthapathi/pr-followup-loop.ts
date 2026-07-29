import type { KshetraConfig } from '../kshetra/config.js';
import type { PrReview } from './gh.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';
import { runSilpi, adaptPrReview } from '../agents/silpi.js';
import { runViharapala } from '../agents/viharapala.js';
import { buildAgentContext } from './dispatch.js';
import { branchName } from './branch.js';
import { AgentAbortedError } from './errors.js';
import { emit as emitTelemetry } from '../telemetry/telemetry.js';

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
// FINALIZE acts on (push + prReply + watermark). Terminal states:
//  • approved  — re-review passed (or the gate is off): FINALIZE ships it.
//  • escalated — Silpi flagged a comment 'escalate': FINALIZE hands to a human.
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
// to do — it performs NO git/gh/bd-state side effects itself. The WORK+FINALIZE
// caller (pr-followup-run.ts) owns push, prReply, watermark, and label changes.
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
    // A round is the transition worth counting; only the loop sees each one. This
    // is an anonymous, count-only metric (no-op unless opted in) — NOT a
    // git/gh/bd state effect, so the pure-producer contract FINALIZE relies on
    // still holds. reReview distinguishes a gated pass from a ship-on-produce one.
    emitTelemetry('pr_followup_round', { round, reReview });
    if (signal?.aborted) throw new AgentAbortedError();

    const context = await buildAgentContext(kshetra, task);
    // prFeedback (the human review) rides every round so Silpi always re-emits
    // the per-comment triage; viharapalaFeedback carries a prior re-review reject.
    const silpiOut = await runSilpi(context, round, viharapalaFeedback, branch, signal, prFeedback);
    lastOutput = silpiOut;

    // Any 'escalate' disposition ends the pass — no amount of looping resolves a
    // comment that needs a human decision. FINALIZE still posts the other
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
