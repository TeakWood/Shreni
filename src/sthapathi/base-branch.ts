import type { KshetraConfig } from '../kshetra/config.js';
import { git } from './git.js';

// The subset of the git wrapper (Shreni-beads-uvu.1 primitives) this
// orchestration needs. Narrowing the type lets tests inject a fake without
// standing up a real origin remote.
export type BaseBranchGit = Pick<
  ReturnType<typeof git>,
  'remoteBranchExists' | 'originDefaultBranch' | 'createBaseBranch'
>;

export interface BaseBranchStatus {
  // Whether repo.mainBranch exists on origin.
  exists: boolean;
}

// Whether the Kshetra's configured base branch (repo.mainBranch) exists on
// origin. This is the SINGLE check consumed by init, the Sthapathi daemon, and
// Suthradhara (their own beads) so those three paths never diverge on how
// "does the base branch exist" is answered.
export async function checkBaseBranch(
  kshetra: KshetraConfig,
  g: BaseBranchGit = git(kshetra),
): Promise<BaseBranchStatus> {
  const exists = await g.remoteBranchExists(kshetra.repo.mainBranch);
  return { exists };
}

// Create the Kshetra's base branch (repo.mainBranch) on origin, cut from
// origin's DEFAULT branch — never local HEAD, which the daemon can't trust.
// Idempotent via git.createBaseBranch (an out-of-band remote creation is
// treated as success). Returns the branch it ensured and the base it cut from,
// for the caller's logging / operator output.
export async function createBaseBranch(
  kshetra: KshetraConfig,
  g: BaseBranchGit = git(kshetra),
): Promise<{ branch: string; base: string }> {
  const branch = kshetra.repo.mainBranch;
  const base = await g.originDefaultBranch();
  await g.createBaseBranch(branch, base);
  return { branch, base };
}
