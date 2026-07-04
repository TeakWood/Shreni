import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { git } from './git.js';

// Thrown when an agent run leaves the bead branch — HEAD moved off the branch,
// or main acquired commits outside the sanctioned squash-merge flow. Carries
// enough detail to flag the bead and (if recovered) point at the salvage ref.
export class OffBranchError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      branch: string;
      expectedMain: string;
      actualHead: string;
      actualMain: string;
    },
  ) {
    super(message);
    this.name = 'OffBranchError';
  }
}

// Snapshot of the sanctioned starting point: we are on the bead branch and main
// sits exactly where origin left it. Captured right after createTaskBranch so a
// later check can prove nothing drifted while an agent ran.
export interface BranchGuard {
  branch: string;
  mainSha: string;
}

export async function captureGuard(kshetra: KshetraConfig, branch: string): Promise<BranchGuard> {
  const g = git(kshetra);
  const mainSha = await g.headSha(kshetra.repo.mainBranch);
  return { branch, mainSha };
}

// Assert the working state is still on the bead branch and main is unchanged.
// Throws OffBranchError otherwise — the caller recovers and flags.
export async function assertOnBranch(kshetra: KshetraConfig, guard: BranchGuard): Promise<void> {
  const g = git(kshetra);
  const [head, mainSha] = await Promise.all([
    g.currentBranch(),
    g.headSha(kshetra.repo.mainBranch),
  ]);

  const offBranch = head !== guard.branch;
  const mainMoved = mainSha !== guard.mainSha;
  if (!offBranch && !mainMoved) return;

  const reason = offBranch
    ? `HEAD is on "${head}", expected bead branch "${guard.branch}"`
    : `main moved from ${guard.mainSha.slice(0, 8)} to ${mainSha.slice(0, 8)} outside the squash-merge flow`;
  throw new OffBranchError(reason, {
    branch: guard.branch,
    expectedMain: guard.mainSha,
    actualHead: head,
    actualMain: mainSha,
  });
}

// Restore the sanctioned invariant after an off-branch violation WITHOUT losing
// the agent's commits: stray commits on main are preserved on a salvage branch,
// then main is reset to where origin left it. Returns the salvage ref name when
// main had diverged (so it can be named in the flag), else null.
export async function recoverOffBranch(
  kshetra: KshetraConfig,
  task: Task,
  guard: BranchGuard,
): Promise<string | null> {
  const g = git(kshetra);
  const strayMain = await g.headSha(kshetra.repo.mainBranch);

  // Get HEAD back onto the bead branch first — we can't move main while on it.
  await g.checkout(guard.branch);

  if (strayMain === guard.mainSha) return null;

  // Preserve the diverged commits before rewinding main.
  const salvage = `shreni-salvage/${task.id}`;
  await g.forceBranch(salvage, strayMain);
  await g.forceBranch(kshetra.repo.mainBranch, guard.mainSha);
  return salvage;
}
