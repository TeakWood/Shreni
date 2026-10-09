import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';
import { parseAcceptanceCriteria } from './task-json.js';
import { git, GitError } from './git.js';
import { gh } from './gh.js';
import { branchName } from './branch.js';
import { pauseKshetra, clearBeadAttempts } from '../kshetra/state.js';
import { notifyOperator } from './errors.js';
import { dispatchParikshakaAsync } from './parikshaka-dispatch.js';
import { regenerateRepoMapAsync } from '../kshetra/repo-map.js';
import { getEntitlements } from '../ext/index.js';
import { emit } from './activity-log.js';
import { engineStore, trackerFor, type EngineTaskStore } from './task-store.js';
import { nowMs, elapsedMs } from './timing.js';
import { emit as emitTelemetry } from '../telemetry/telemetry.js';
import { resolvePrFollowup, detectPrFeedback } from './pr-followup.js';

// Resolve the effective merge policy: SHRENI_MERGE_POLICY overrides the config
// (the "+CLI override" from yds.9/3r2 — set it in the environment `shreni start`
// runs in), then the Kshetra's repo.mergePolicy, defaulting to 'push'.
export function resolveMergePolicy(kshetra: KshetraConfig): 'push' | 'pr' {
  const env = process.env.SHRENI_MERGE_POLICY;
  if (env === 'pr' || env === 'push') return env;
  return kshetra.repo.mergePolicy ?? 'push';
}

function buildCommitMessage(task: Task, output: SilpiOutput): string {
  const lines = [
    `${task.title} (${task.id})`,
    '',
    output.summary,
    '',
    `Confidence: ${output.confidenceScore}%`,
    `Files changed: ${output.filesChanged.length}`,
  ];
  if (output.questionsForReviewer.length) {
    lines.push('', 'Questions for reviewer:', ...output.questionsForReviewer.map(q => `- ${q}`));
  }
  return lines.join('\n');
}

// PR body for mergePolicy 'pr' (4fu.1). Extends the squash-commit message with
// the two review-context blocks a human merger needs at a glance: the bead's
// acceptance criteria and the reviewer's verdict (verdict, score, must-fix
// items). The squash-merge path keeps using buildCommitMessage unchanged — a git
// commit message has no room for this, but a PR body does, so only the PR
// carries the extra context.
//
// taskDetails is the tracker's show payload for the task (the same bundle
// Viharapala reviewed against). We render ONLY the acceptance_criteria field
// parsed out of it — dumping the whole JSON blob would be mislabeled (it carries
// the full bead + every dependency) and, being pretty-printed JSON, would mangle
// the PR's markdown (bqn).
export function buildPrBody(
  task: Task,
  output: SilpiOutput,
  feedback: ViharapalaOutput,
  taskDetails: string,
): string {
  const lines: string[] = [buildCommitMessage(task, output), ''];

  const criteria = parseAcceptanceCriteria(taskDetails, task.id);
  lines.push('## Acceptance criteria', '');
  lines.push(criteria || '_(no acceptance criteria recorded)_', '');

  lines.push('## Reviewer verdict', '');
  lines.push(`- Verdict: **${feedback.verdict}**`);
  lines.push(`- Score: ${feedback.overallScore}/100`);
  if (feedback.mustFix.length > 0) {
    lines.push('- Must-fix:');
    for (const item of feedback.mustFix) lines.push(`  - ${item}`);
  } else {
    lines.push('- Must-fix: none');
  }

  return lines.join('\n');
}

async function rebaseBranchOnMain(
  kshetra: KshetraConfig,
  task: Task,
  branch: string,
): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  const tracker = trackerFor(kshetra);
  await tracker.addNote(task.id, 'main has new commits — attempting rebase before merge');
  try {
    await g.checkout(branch);
    await g.rebase(`origin/${main}`);
    await g.checkout(main);
    await tracker.addNote(task.id, 'rebase onto main succeeded');
  } catch (err) {
    await g.rebase('--abort');
    await g.checkout(main);
    throw new GitError('REBASE_FAILED', (err as Error).message, err);
  }
}

export async function safePush(kshetra: KshetraConfig, task: Task): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  try {
    await g.push('origin', main);
  } catch (pushErr) {
    const msg = (pushErr as Error).message ?? '';
    if (!msg.includes('non-fast-forward')) throw pushErr;

    await trackerFor(kshetra).addNote(
      task.id,
      'push rejected (non-fast-forward) — pull-rebase and retrying',
    );
    try {
      await g.pull('--rebase', 'origin', main);
      await g.push('origin', main);
    } catch (retryErr) {
      throw new GitError(
        'PUSH_FAILED',
        `Push failed after rebase retry: ${(retryErr as Error).message}`,
        retryErr,
      );
    }
  }
}

export async function handleMergeConflict(
  kshetra: KshetraConfig,
  task: Task,
  _branch: string,
  conflictedFiles: string[],
): Promise<void> {
  const taskFiles = task.context?.relatedFiles ?? [];
  const outOfScope = conflictedFiles.filter(f => !taskFiles.includes(f));
  const tracker = trackerFor(kshetra);

  if (outOfScope.length > 0) {
    await tracker.flag(
      task.id,
      `Merge conflict in files outside task scope: ${outOfScope.join(', ')}. ` +
        `Silpi may have drifted. Branch kept for inspection.`,
    );
    pauseKshetra(kshetra, {
      reason: 'git_failed',
      manual: true,
      message: `Out-of-scope conflict: ${outOfScope.join(', ')}`,
    });
    await notifyOperator(kshetra, task, 'merge_conflict_out_of_scope');
    return;
  }

  if ((task.round ?? 0) < kshetra.agents.maxRoundsPerBead) {
    await tracker.addNote(
      task.id,
      `Merge conflict in task files — re-dispatching Silpi with conflict context. ` +
        `Conflicted: ${conflictedFiles.join(', ')}`,
    );
    // Phase 5: scheduleResumeWithConflictContext(kshetra, task, conflictedFiles)
  } else {
    await tracker.flag(
      task.id,
      `Merge conflict after max rounds: ${conflictedFiles.join(', ')}`,
    );
    pauseKshetra(kshetra, {
      reason: 'git_failed',
      manual: true,
      message: `Unresolved merge conflict: ${conflictedFiles.join(', ')}`,
    });
    await notifyOperator(kshetra, task, 'merge_conflict');
  }
}

export async function safeMerge(
  kshetra: KshetraConfig,
  task: Task,
  branch: string,
): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;

  await g.fetch('origin', main);

  const mainAhead = await g.revsBetween(branch, `origin/${main}`);
  if (mainAhead.length > 0) {
    await rebaseBranchOnMain(kshetra, task, branch);
  }

  const conflicts = await g.mergeTree(branch, main);
  if (conflicts.length > 0) {
    await handleMergeConflict(kshetra, task, branch, conflicts);
    return;
  }

  await g.checkout(main);
  await g.merge('--squash', branch);
  await g.commit(`bead-${task.id}: ${task.title}`);
  await safePush(kshetra, task);
}

export async function squashMergeAndClose(
  task: Task,
  kshetra: KshetraConfig,
  output: SilpiOutput,
): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  const branch = branchName(task);
  // Verify and extend the lease right before the merge, which is outside the
  // database (policy spec, "Running work").
  const store = engineStore(kshetra);
  await store.beforeMerge(task.id);

  // Time the merge + push at the site (epic hto / Study A3).
  const mergeStart = nowMs();
  await g.checkout(main);
  await g.merge('--squash', branch);
  await g.commit(buildCommitMessage(task, output));
  await g.push('origin', main);
  const mergeDurationMs = elapsedMs(mergeStart);

  // Decision-grade (4a2.2): the approved work landed on main. Record the merge
  // policy used and the squash commit SHA — the provenance of what was merged and
  // how. Emitted while the claiming task's runId is still current, so the entry
  // correlates to the run that produced the work.
  //
  // GUARDED (4a2.9): the merge is already committed + pushed by this point, so a
  // ledger-fold failure must never reject squashMergeAndClose — that would skip
  // finish, Parikshaka dispatch, clearBeadAttempts, and the branch cleanup
  // below, leaving the task unfinished with its branch undeleted while the code
  // is already on main. Both the headSha() subprocess AND the emit are wrapped;
  // a headSha failure degrades the entry to no SHA rather than failing the merge.
  try {
    let sha: string | undefined;
    try {
      sha = await g.headSha();
    } catch {
      // record the merge happened even if we couldn't read the SHA
    }
    emit({ type: 'merge_done', kshetra: kshetra.id, beadId: task.id, mergePolicy: 'push', ...(sha ? { sha } : {}), durationMs: mergeDurationMs });
  } catch {
    // A merge_done ledger-fold failure must never fail an already-pushed merge.
  }

  // Refresh the cached repo/symbol map (Shreni-beads-vcz) now that main has new
  // structure — fire-and-forget so it never blocks the loop; the next bead's
  // cold start reads the fresher map.
  regenerateRepoMapAsync(kshetra);

  // Fire Parikshaka after merge commit — non-blocking, does not stall the main
  // loop. The post-merge test agent is an optional capability: the core asks
  // Entitlements rather than assuming it's on (epg.5). Default entitlements
  // enable it, so it always runs locally; an optional extension may gate it.
  if (getEntitlements().capability('parikshaka')) {
    dispatchParikshakaAsync(kshetra, task, output);
  }

  const note =
    `Merged: confidence=${output.confidenceScore} ` +
    `files=${output.filesChanged.length} — ${output.summary.slice(0, 120)}`;
  // finish; the engine settles the parent container (children.settled). The
  // change is already on main: if finish is refused, flag the task for a
  // human rather than let it be released and worked again.
  try {
    await store.finish(task.id, note);
  } catch (err) {
    await store.flag(task.id, `merged to ${main} but finish failed: ${(err as Error).message}. Check it and finish by hand.`);
  }

  // Activation signal (yds.5) — opt-in + anonymous, a no-op unless enabled.
  emitTelemetry('task_merged', { policy: 'push' });

  // The bead succeeded — clear any recovery attempt count it accumulated.
  clearBeadAttempts(kshetra, task.id);

  // Force-delete: after `git merge --squash` the bead branch's commits are not
  // reachable as merge parents on main, so git treats it as "not fully merged"
  // and a plain `-d` always refuses. The work is already squashed onto main and
  // pushed, so the local branch is safe to drop.
  await g.deleteBranch(branch, { force: true });
}

// PR merge policy (3r2). On APPROVE, instead of squash-merging to main, push the
// task branch and open a PR, then DEFER: the task waits on its PR (dependents
// stay blocked until the code is on main). It is finished later — only when its
// PR actually merges — by reconcilePullRequests. Decouples "where code lands" from "when the next bead
// starts" (the next READY bead branches from the unchanged main immediately).
export async function openPrAndDefer(
  task: Task,
  kshetra: KshetraConfig,
  output: SilpiOutput,
  feedback: ViharapalaOutput,
  taskDetails: string,
): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  const branch = branchName(task);
  const store = engineStore(kshetra);

  // Time the branch push + PR open at the site (epic hto / Study A3).
  const openStart = nowMs();
  // Publish the bead branch so the PR has a head to compare against main.
  await g.push('origin', branch);

  const url = await gh(kshetra.repo.path).prCreate({
    base: main,
    head: branch,
    title: `${task.title} (${task.id})`,
    body: buildPrBody(task, output, feedback, taskDetails),
  });
  const openDurationMs = elapsedMs(openStart);

  // The PR goes on the attempt's evidence first: submit's hasOpenPr guard reads it.
  // The PR exists now: if recording it fails, flag the task with the PR rather
  // than let it be released and worked again (a second PR).
  try {
    await store.deferForPr(task.id, url);
  } catch (err) {
    await store.flag(task.id, `opened ${url} but could not record it: ${(err as Error).message}. Submit it by hand.`);
  }

  // Decision-grade (4a2.2): under mergePolicy 'pr' the landing decision is "open
  // PR #N and defer". Record it here — while the run's runId is still current —
  // with the PR number parsed from the gh URL. (The subsequent human merge is
  // reconciled later, outside the run, where the runId would be stale.)
  const prNumber = Number(url.match(/\/(\d+)(?:[/?#].*)?$/)?.[1]);
  emit({
    type: 'merge_done',
    kshetra: kshetra.id,
    beadId: task.id,
    mergePolicy: 'pr',
    ...(Number.isInteger(prNumber) ? { pr: prNumber } : {}),
    durationMs: openDurationMs,
  });

  // The task branch is deliberately NOT deleted — the open PR needs it. It is
  // dropped when the PR merges (reconcilePullRequests). Parikshaka is likewise
  // deferred: it runs post-merge, so it fires from the reconcile path, not here.
}

// Reconcile deferred PRs (mergePolicy 'pr'). For each task waiting on its PR,
// check the PR: MERGED → finish the task (the engine settles its container)
// and drop the branch; CLOSED-without-merge → flag it for a human; OPEN with
// unaddressed feedback → reopen it boosted for a follow-up round; OPEN (or gh
// unavailable) → leave it for a later pass. Read-mostly and gh-tolerant: any gh
// failure degrades to "nothing to reconcile" rather than throwing. Intended to
// run only when the worker is IDLE, so its branch deletes never race an
// in-flight agent's work tree.
export async function reconcilePullRequests(kshetra: KshetraConfig): Promise<void> {
  const store = engineStore(kshetra);
  const waiting = await store.listAwaitingMerge();
  if (waiting.length === 0) return;
  const client = gh(kshetra.repo.path);
  const g = git(kshetra);
  for (const t of waiting) {
    // One task's failure (a refused finish, a lost connection) mustn't hold up the rest.
    try {
      await reconcileOne(kshetra, store, t, client, g);
    } catch (err) {
      console.warn(`[shreni reconcile:${kshetra.id}] ${t.id}: ${(err as Error).message}`);
    }
  }
}

// Detection for the active follow-up loop (epic hjw), run on the 5-min reconcile
// pass for an OPEN PR. Reads the rich PR status + the task's watermark and, if
// there is unaddressed feedback (a new CHANGES_REQUESTED review, a failing
// REQUIRED check, or a foreign commit), reopens the task boosted (followUp) so
// it is claimed ahead of other work. The watermark is advanced by the FINALIZE
// step once the feedback is addressed. gh-tolerant: a null status (unauthenticated / race to terminal
// state) is a no-op this pass. Foreign-commit detection is disabled unless the
// operator has declared repo.prFollowupSelfLogins (else we cannot tell our own
// pushes apart and would loop on them).
async function detectAndStampFollowup(
  kshetra: KshetraConfig,
  bead: { id: string },
  branch: string,
  client: ReturnType<typeof gh>,
  /** The store reconcile started with. */
  store: EngineTaskStore,
): Promise<void> {
  const status = await client.prStatus(branch);
  if (!status || status.state !== 'OPEN') return;

  const selfLogins = kshetra.repo.prFollowupSelfLogins;
  const watermark = await store.readWatermark(bead.id);
  const feedback = detectPrFeedback({
    // Suppress foreign-commit detection when we can't identify ourselves.
    status: selfLogins.length ? status : { ...status, commits: [] },
    watermark,
    selfLogins,
    requiredChecks: kshetra.repo.prFollowupRequiredChecks,
  });
  if (!feedback) return;

  // followUp reopens it boosted, so it is claimed ahead of other ready work.
  await store.needsFollowup(bead.id);
  console.log(
    `[shreni reconcile:${kshetra.id}] ${bead.id} PR has unaddressed feedback ` +
      `(${feedback.triggers.join(', ')}) — reopened for a follow-up`,
  );
}

/** One task waiting on its PR. */
async function reconcileOne(
  kshetra: KshetraConfig, store: EngineTaskStore, t: { id: string; title: string; slug: string },
  client: ReturnType<typeof gh>, g: ReturnType<typeof git>,
): Promise<void> {
  {
    const branch = branchName(t);
    const pr = await client.prView(branch);
    if (!pr) return;
    if (pr.state === 'OPEN') {
      if (resolvePrFollowup(kshetra)) await detectAndStampFollowup(kshetra, t, branch, client, store);
      return;
    }
    if (pr.state === 'MERGED') {
      // As on the push path: the change is on main, so a refused finish (a manual
      // check waits on the developer) flags the task rather than leave it waiting.
      try {
        await store.finish(t.id, `Merged via PR: ${pr.url}`);
      } catch (err) {
        await store.flag(t.id, `merged via PR ${pr.url} but finish failed: ${(err as Error).message}. Check it and finish by hand.`);
      }
      emitTelemetry('task_merged', { policy: 'pr' });
      clearBeadAttempts(kshetra, t.id);
      try { await g.deleteBranch(branch, { force: true }); } catch { /* already gone */ }
      try { await g.push('origin', '--delete', branch); } catch { /* auto-deleted */ }
      console.log(`[shreni reconcile:${kshetra.id}] ${t.id} merged via PR — done`);
    } else {
      await store.prDeclined(t.id,
        `PR closed without merging: ${pr.url}. The change did not land on ${kshetra.repo.mainBranch} — investigate manually.`);
      console.log(`[shreni reconcile:${kshetra.id}] ${t.id} PR closed unmerged — blocked`);
    }
  }
}
