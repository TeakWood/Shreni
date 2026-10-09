import type { KshetraConfig } from '../kshetra/config.js';
import { git } from './git.js';

// RECOVER after a crash, restart or self-heal: the task graph engine's leases
// return interrupted work by themselves (policy spec, "Running work"), so only
// the work tree needs reconciling. See the Sthapathi workflow design §4.3.
/**
 * A clean main and no stale bead-* branches. `keepBranch` protects an
 * in-flight task's branch.
 */
export async function resetWorkTree(kshetra: KshetraConfig, opts: { keepBranch?: string } = {}): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;
  await g.resetHard();
  await g.checkout(main);
  await g.clean();
  // A leftover branch makes preFlightCheck reject its task forever ("branch already exists").
  for (const branch of await g.branches('bead-')) {
    if (branch === opts.keepBranch) continue;
    await g.deleteBranch(branch, { force: true });
  }
}
