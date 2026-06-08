import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git, GitError } from './git.js';
import { branchName } from './branch.js';
import { pauseKshetra } from '../kshetra/state.js';
import { notifyVichara } from './errors.js';
import { dispatchParikshakaAsync } from './parikshaka-dispatch.js';

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
    await notifyVichara(kshetra, task, 'merge_conflict_out_of_scope');
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
    await notifyVichara(kshetra, task, 'merge_conflict');
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

  // Fire Parikshaka after merge commit — non-blocking, does not stall the main loop
  dispatchParikshakaAsync(kshetra, task, output);

  const note =
    `Merged: confidence=${output.confidenceScore} ` +
    `files=${output.filesChanged.length} — ${output.summary.slice(0, 120)}`;
  await bd(kshetra).close(task.id, note);

  await syncBeads(kshetra);

  await g.deleteBranch(branch);
}