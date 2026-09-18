import { loadRegistry } from '../kshetra/registry';
import { loadState } from '../kshetra/state';
import { resumeKshetraById } from './pause';
import { checkBaseBranch, createBaseBranch } from '../sthapathi/base-branch';
import { MISSING_BASE_BRANCH_REASON } from '../sthapathi/pickup';

export type BaseBranchCreateResult =
  | { status: 'not_found'; id: string }
  // The Kshetra isn't paused for a missing base branch — refuse gracefully
  // rather than clobber an unrelated pause (or act when nothing is wrong).
  | { status: 'not_paused_for_missing_base'; id: string; reason?: string }
  // The branch already existed on origin (created out-of-band between the pause
  // and this approval) — treated as success; the pause is cleared.
  | { status: 'already_exists'; id: string; branch: string }
  // Created origin/<branch> from origin/<base> and resumed the Kshetra.
  | { status: 'created'; id: string; branch: string; base: string };

// The operator-facing half of the daemon's missing-base flow (Shreni-beads-uvu):
// for a Kshetra paused because its configured base branch is absent on origin,
// create the branch (cut from origin's default via the shared .2 helper) and
// resume the Kshetra so the next poll proceeds. Idempotent — a branch that
// already exists is treated as success. Refuses gracefully when the Kshetra
// isn't paused for this reason.
export async function createBaseBranchForKshetra(id: string): Promise<BaseBranchCreateResult> {
  const kshetra = loadRegistry().find(k => k.id === id);
  if (!kshetra) return { status: 'not_found', id };

  const state = loadState().kshetras[id];
  const pausedForThis = state?.paused === true && state.reason === MISSING_BASE_BRANCH_REASON;
  if (!pausedForThis) {
    return { status: 'not_paused_for_missing_base', id, reason: state?.reason };
  }

  const branch = kshetra.repo.mainBranch;
  // Re-check existence: the branch may have appeared out-of-band since the
  // daemon paused. If so, skip creation and just clear the pause.
  const { exists } = await checkBaseBranch(kshetra);
  if (exists) {
    resumeKshetraById(id);
    return { status: 'already_exists', id, branch };
  }

  const created = await createBaseBranch(kshetra);
  resumeKshetraById(id);
  return { status: 'created', id, branch: created.branch, base: created.base };
}
