import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { git } from './git.js';

// Only the id + slug are needed to name a branch, so any object carrying those
// works (a full Task, or the lighter awaiting-merge bead reconcile reconstructs).
export function branchName(task: Pick<Task, 'id' | 'slug'>): string {
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