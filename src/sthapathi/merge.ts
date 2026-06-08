import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';
import { branchName } from './branch.js';

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

  const note =
    `Merged: confidence=${output.confidenceScore} ` +
    `files=${output.filesChanged.length} — ${output.summary.slice(0, 120)}`;
  await bd(kshetra).close(task.id, note);

  await syncBeads(kshetra);

  await g.deleteBranch(branch);
}