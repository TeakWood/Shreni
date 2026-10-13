import type { KshetraConfig } from '../kshetra/config.js';
import { git } from './git.js';

// RECOVER after a crash, restart or self-heal: the task graph engine's leases
// return interrupted work by themselves (policy spec, "Running work"), so only
// the work tree needs reconciling. See the Sthapathi workflow design §4.3.
export interface DiscardedBranch { branch: string; lastCommit: string }

/**
 * A clean main and no stale bead-* branches. `keepBranch` protects an
 * in-flight task's branch. Returns the branches deleted, each with its last
 * commit, so recovery can say what it discarded.
 */
export async function resetWorkTree(kshetra: KshetraConfig, opts: { keepBranch?: string } = {}): Promise<DiscardedBranch[]> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  await g.resetHard();
  await g.checkout(main);
  await g.clean();
  // A leftover branch makes preFlightCheck reject its task forever ("branch already exists").
  const discarded: DiscardedBranch[] = [];
  for (const branch of await g.branches('bead-')) {
    if (branch === opts.keepBranch) continue;
    const lastCommit = await g.lastCommit(branch).catch(() => 'unknown');
    await g.deleteBranch(branch, { force: true });
    discarded.push({ branch, lastCommit });
  }
  return discarded;
}
