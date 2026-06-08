import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { git } from './git.js';

export function branchName(task: Task): string {
  return `bead-${task.id}/${task.slug}`;
}

// Ensures we are on the latest main before branching so the task branch is
// never behind origin. Checkout → pull → branch in that order.
export async function createTaskBranch(task: Task, kshetra: KshetraConfig): Promise<string> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  await g.checkout(main);
  await g.pull('--rebase', 'origin', main);
  return g.createBranch(task);
}