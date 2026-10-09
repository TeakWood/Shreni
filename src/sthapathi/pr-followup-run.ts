import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import type { PrReview } from './gh.js';
import { engineStore, type EngineTaskStore } from './task-store.js';
import { git } from './git.js';
import { gh } from './gh.js';
import { branchName } from './branch.js';
import { notifyOperator } from './errors.js';
import { clearBeadAttempts } from '../kshetra/state.js';
import { emit as emitTelemetry } from '../telemetry/telemetry.js';
import { detectPrFeedback, type PrFeedback } from './pr-followup.js';
import { runPrFollowupLoop, type PrFollowupInput, type PrFollowupResult } from './pr-followup-loop.js';

// The CHANGES_REQUESTED review to address, or a synthetic one when the trigger is
// a failing check / foreign commit with no human review (so Silpi still gets
// context for the round).
function reviewFor(feedback: PrFeedback): PrReview {
  const newest = feedback.changesRequested[feedback.changesRequested.length - 1];
  if (newest) return newest;
  const parts: string[] = [];
  if (feedback.failingChecks.length) {
    parts.push(`Required check(s) failing: ${feedback.failingChecks.map((c) => c.name).join(', ')}. Fix the underlying cause.`);
  }
  if (feedback.foreignCommits.length) {
    parts.push(`The branch was re-synced onto commits pushed by others — build on the current head.`);
  }
  return {
    author: null,
    state: 'CHANGES_REQUESTED',
    body: parts.join(' ') || 'Address the open-PR feedback.',
    submittedAt: null,
    comments: [],
  };
}

// D9 Option A: name + a short summary per failing required check. The detail
// leans on the local health gate Silpi runs, not CI logs (a full-log fetch is a
// deferred non-goal).
function failingCheckSummaries(feedback: PrFeedback): { name: string; summary: string }[] {
  return feedback.failingChecks.map((c) => ({
    name: c.name,
    summary: `reported ${c.conclusion ?? 'a failure'} on the PR head — reproduce and fix via the local gate`,
  }));
}

// WORK + FINALIZE for a PR follow-up bead (epic hjw), dispatched by the worker's
// runTask when task.followup is set. PREPARE has already re-synced the branch to
// the PR head. Here Sthapathi owns EVERY side effect (ARD §4.2/G4):
//
//   read PR status → detect unaddressed feedback → runPrFollowupLoop (produces)
//   → approved:  push  → prReply (never resolve) → advance watermark → resubmit
//   → escalate/exhaust: flag human → notify
//
// Push STRICTLY precedes reply; a push failure posts no reply and resubmits, so
// the next reconcile pass detects the same feedback and retries. Returns the {approved,note} shape the worker's
// error funnel expects.
export async function runPrFollowupTask(
  kshetra: KshetraConfig,
  task: Task,
  signal?: AbortSignal,
): Promise<{ approved: boolean; note: string }> {
  const client = gh(kshetra.repo.path);
  const branch = branchName(task);
  // Captured once: the whole round uses the same store.
  const store = engineStore(kshetra);

  // Re-read fresh PR state — the 5-min detection may be stale, and we are now
  // committed to this bead so a gh call is fine (this is not the fast poll).
  const status = await client.prStatus(branch);
  if (!status || status.state !== 'OPEN') {
    // The PR merged/closed/vanished since detection — drop the follow-up marker
    // and let reconcile handle the terminal state (or re-detect next pass).
    await store.resubmit(task.id, 'the PR is no longer open; reconcile settles it');
    return { approved: false, note: 'PR no longer open — follow-up skipped' };
  }

  const selfLogins = kshetra.repo.prFollowupSelfLogins;
  const watermark = await store.readWatermark(task.id);
  const feedback = detectPrFeedback({
    status: selfLogins.length ? status : { ...status, commits: [] },
    watermark,
    selfLogins,
    requiredChecks: kshetra.repo.prFollowupRequiredChecks,
  });
  if (!feedback) {
    // Already addressed (e.g. the reviewer approved after our last push) — clear
    // the marker so the bead falls back to plain awaiting-merge.
    await store.resubmit(task.id, 'no unaddressed feedback');
    return { approved: false, note: 'no unaddressed feedback — label cleared' };
  }

  const input: PrFollowupInput = {
    review: reviewFor(feedback),
    failingChecks: failingCheckSummaries(feedback),
    startRound: feedback.round,
  };
  const result = await runPrFollowupLoop(task, kshetra, input, signal);

  return finalize(kshetra, task, branch, result, store);
}

async function finalize(
  kshetra: KshetraConfig,
  task: Task,
  branch: string,
  result: PrFollowupResult,
  store: EngineTaskStore,
): Promise<{ approved: boolean; note: string }> {
  const g = git(kshetra);

  if (result.outcome === 'approved') {
    // Push BEFORE reply (G4): the reviewer must never read "fixed" on a PR whose
    // head has not moved. A push failure aborts finalize — no reply, label kept.
    try {
      await g.push('origin', branch);
    } catch (err) {
      const note = `PR follow-up push failed: ${(err as Error).message} — no replies posted; will retry next pass`;
      // Back to waiting on the PR; the next reconcile pass detects the same
      // feedback and reopens it.
      await store.note(task.id, note);
      await store.resubmit(task.id, 'follow-up push failed; retry on the next pass');
      return { approved: false, note: 'push failed — no reply posted' };
    }

    // Post the drafted replies (never resolve a human's thread, D6). Best-effort:
    // prReply already swallows failures, so a flaky comment never wedges the loop.
    const client = gh(kshetra.repo.path);
    for (const r of result.output?.commentResponses ?? []) {
      await client.prReply(branch, r.reply);
    }

    // Advance the watermark to the just-pushed head so the same feedback is not
    // re-addressed, and drop the marker (awaiting-merge stays — the human still
    // merges). Head sha is best-effort; a failure leaves head null (still safe).
    let head: string | null = null;
    try {
      head = await g.headSha();
    } catch { /* leave head null */ }
    await store.writeWatermark(task.id, { head, round: result.rounds, at: new Date().toISOString() });
    // Back to waiting on its PR.
    await store.resubmit(task.id, `PR follow-up pushed (${result.rounds} round(s))`);
    return { approved: true, note: `PR follow-up pushed (${result.rounds} round(s))` };
  }

  // escalated / exhausted → hand to a human (ARD §4.2): flag the task. The PR
  // is still open and a human may yet merge it; the branch/PR is left as-is.
  await store.flag(task.id, `PR follow-up ${result.outcome}: ${result.note}. Handed to a human.`);
  // A blocked bead is no longer forward progress; clear its recover-attempt count
  // so a later human re-open starts fresh.
  clearBeadAttempts(kshetra, task.id);
  // result.outcome is narrowed to 'escalated' | 'exhausted' here (approved returned
  // above), so the templated name is a known TelemetryEventName. Count-only.
  emitTelemetry(`pr_followup_${result.outcome}`, { rounds: result.rounds });
  await notifyOperator(kshetra, task, `pr_followup_${result.outcome}`);
  return { approved: false, note: `PR follow-up ${result.outcome}` };
}
