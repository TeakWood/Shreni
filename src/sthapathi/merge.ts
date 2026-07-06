import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git, GitError } from './git.js';
import { gh } from './gh.js';
import { branchName } from './branch.js';
import { toSlug } from './pickup.js';
import { pauseKshetra, clearBeadAttempts } from '../kshetra/state.js';
import { notifyOperator } from './errors.js';
import { dispatchParikshakaAsync } from './parikshaka-dispatch.js';
import { getEntitlements } from '../ext/index.js';
import { emit as emitTelemetry } from '../telemetry/telemetry.js';

// Label marking a bead whose approved work is on a PR awaiting a human merge
// (mergePolicy 'pr'). The bead stays open + in_progress so bd dependents stay
// blocked; reconcilePullRequests keys on this label, and RECOVER excludes it so
// a deferred bead is never reopened and re-worked on restart.
export const AWAITING_MERGE_LABEL = 'awaiting-merge';

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

async function rebaseBranchOnMain(
  kshetra: KshetraConfig,
  task: Task,
  branch: string,
): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  await bd(kshetra).addNote(task.id, 'main has new commits — attempting rebase before merge');
  try {
    await g.checkout(branch);
    await g.rebase(`origin/${main}`);
    await g.checkout(main);
    await bd(kshetra).addNote(task.id, 'rebase onto main succeeded');
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

    await bd(kshetra).addNote(
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
  const bdClient = bd(kshetra);

  if (outOfScope.length > 0) {
    await bdClient.flag(
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
    await bdClient.addNote(
      task.id,
      `Merge conflict in task files — re-dispatching Silpi with conflict context. ` +
        `Conflicted: ${conflictedFiles.join(', ')}`,
    );
    // Phase 5: scheduleResumeWithConflictContext(kshetra, task, conflictedFiles)
  } else {
    await bdClient.flag(
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

  await g.checkout(main);
  await g.merge('--squash', branch);
  await g.commit(buildCommitMessage(task, output));
  await g.push('origin', main);

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
  await bd(kshetra).close(task.id, note);

  // Activation signal (yds.5) — opt-in + anonymous, a no-op unless enabled.
  emitTelemetry('task_merged', { policy: 'push' });

  // The bead succeeded — clear any recovery attempt count it accumulated.
  clearBeadAttempts(kshetra, task.id);

  await syncBeads(kshetra);

  // Force-delete: after `git merge --squash` the bead branch's commits are not
  // reachable as merge parents on main, so git treats it as "not fully merged"
  // and a plain `-d` always refuses. The work is already squashed onto main and
  // pushed, so the local branch is safe to drop.
  await g.deleteBranch(branch, { force: true });
}

// PR merge policy (3r2). On APPROVE, instead of squash-merging to main, push the
// bead branch and open a PR, then DEFER: mark the bead awaiting-merge but leave
// it open (in_progress) so bd dependents stay blocked until the code is on main.
// The bead is closed later — only when its PR actually merges — by
// reconcilePullRequests. Decouples "where code lands" from "when the next bead
// starts" (the next READY bead branches from the unchanged main immediately).
export async function openPrAndDefer(
  task: Task,
  kshetra: KshetraConfig,
  output: SilpiOutput,
): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  const branch = branchName(task);
  const bdClient = bd(kshetra);

  // Publish the bead branch so the PR has a head to compare against main.
  await g.push('origin', branch);

  const url = await gh(kshetra.repo.path).prCreate({
    base: main,
    head: branch,
    title: `${task.title} (${task.id})`,
    body: buildCommitMessage(task, output),
  });

  await bdClient.addNote(task.id, `PR opened (awaiting merge): ${url}`);
  await bdClient.addLabel(task.id, AWAITING_MERGE_LABEL);
  await syncBeads(kshetra);
  // The bead branch is deliberately NOT deleted — the open PR needs it. It is
  // dropped when the PR merges (reconcilePullRequests). Parikshaka is likewise
  // deferred: it runs post-merge, so it fires from the reconcile path, not here.
}

interface AwaitingMergeBead {
  id: string;
  slug: string;
  title: string;
}

// Parse `bd list --json` (awaiting-merge filter) into the id + reconstructed
// slug needed to name each bead's branch. bd carries no slug field, so the slug
// is rebuilt deterministically from the title via the same toSlug used to name
// the branch at creation.
export function parseAwaitingMerge(raw: string): AwaitingMergeBead[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const beads: AwaitingMergeBead[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (typeof item.id !== 'string' || typeof item.title !== 'string') continue;
    beads.push({ id: item.id, title: item.title, slug: toSlug(item.title) });
  }
  return beads;
}

// Reconcile deferred PR beads (mergePolicy 'pr'). For each bead labelled
// awaiting-merge, check its PR: MERGED → close the bead and drop the branch;
// CLOSED-without-merge → block for a human and clear the marker; OPEN (or gh
// unavailable) → leave it for a later pass. Read-mostly and gh-tolerant: any gh
// failure degrades to "nothing to reconcile" rather than throwing. Intended to
// run only when the worker is IDLE, so its branch deletes never race an
// in-flight agent's work tree.
export async function reconcilePullRequests(kshetra: KshetraConfig): Promise<void> {
  const bdClient = bd(kshetra);

  let raw: string;
  try {
    raw = await bdClient.list({ status: 'in_progress', label: AWAITING_MERGE_LABEL });
  } catch (err) {
    console.warn(`[shreni reconcile:${kshetra.id}] could not list awaiting-merge beads: ${(err as Error).message}`);
    return;
  }

  const beads = parseAwaitingMerge(raw);
  if (beads.length === 0) return;

  const client = gh(kshetra.repo.path);
  const g = git(kshetra);

  for (const bead of beads) {
    const branch = branchName(bead);
    const pr = await client.prView(branch);
    if (!pr || pr.state === 'OPEN') continue;

    if (pr.state === 'MERGED') {
      await bdClient.close(bead.id, `Merged via PR: ${pr.url}`);
      emitTelemetry('task_merged', { policy: 'pr' });
      clearBeadAttempts(kshetra, bead.id);
      // Drop the merged branch locally and (best-effort) on the remote — GitHub
      // may already have auto-deleted the head branch, so ignore failures.
      try {
        await g.deleteBranch(branch, { force: true });
      } catch { /* local branch already gone */ }
      try {
        await g.push('origin', '--delete', branch);
      } catch { /* remote branch already gone (auto-delete) */ }
      await syncBeads(kshetra);
      console.log(`[shreni reconcile:${kshetra.id}] ${bead.id} merged via PR — closed`);
    } else {
      // CLOSED without merging: a human declined the PR. Clear the marker so it
      // is not reconciled again, and block for review — the change did not land.
      await bdClient.removeLabel(bead.id, AWAITING_MERGE_LABEL);
      await bdClient.flag(
        bead.id,
        `PR closed without merging: ${pr.url}. The change did not land on ${kshetra.repo.mainBranch} — investigate manually.`,
      );
      await syncBeads(kshetra);
      console.log(`[shreni reconcile:${kshetra.id}] ${bead.id} PR closed unmerged — blocked`);
    }
  }
}