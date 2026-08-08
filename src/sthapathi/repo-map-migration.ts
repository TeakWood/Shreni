import { readFile, appendFile } from 'fs/promises';
import { join } from 'path';
import type { KshetraConfig } from '../kshetra/config.js';
import { git } from './git.js';
import { REPO_MAP_RELATIVE_PATH } from '../kshetra/repo-map.js';

// One-shot self-heal for Kshetras created before .shreni/repo-map.md was
// gitignored. The map is a cache Shreni regenerates on every merge; if a repo
// TRACKS it, the post-merge regen leaves it modified-and-uncommitted, and
// preFlightCheck (which rejects any dirty tracked file) then wedges the worker on
// every poll. New Kshetras ignore it at init (init-kshetra's GITIGNORE_MARKERS),
// but repos initialised earlier committed it. This untracks it (keeping the
// on-disk cache), ensures it is gitignored, and commits — so a legacy repo
// self-heals on the next worker start with no manual `git rm --cached`.
//
// Idempotent: once the map is untracked, isTracked is false and this is a no-op.
// Best-effort: any git/fs failure is swallowed and reverts cleanly — the
// preFlightCheck discard already prevents the wedge regardless, so a failed
// migration only means the churn persists, never a crash or a half-staged tree.
//
// PRECONDITION: must run on a clean main (the rollback resets to HEAD). Call it
// right after recoverKshetra, which leaves exactly that, and before the poll loop
// arms. Returns true only when it actually untracked the map this run.
export async function untrackCommittedRepoMap(kshetra: KshetraConfig): Promise<boolean> {
  const g = git(kshetra);
  try {
    if (!(await g.isTracked(REPO_MAP_RELATIVE_PATH))) return false;

    await ensureGitignored(kshetra.repo.path, REPO_MAP_RELATIVE_PATH);
    // Stage the untrack (keeps the working-tree file) + the .gitignore edit, then
    // commit so the tree ends clean — a bare `git rm --cached` would otherwise
    // leave a STAGED deletion that preFlightCheck rejects as dirty.
    await g.rmCached(REPO_MAP_RELATIVE_PATH);
    await g.add('.gitignore');
    try {
      await g.commit('chore: untrack .shreni/repo-map.md (regenerated cache, not source)');
    } catch (err) {
      // Commit failed (e.g. a pre-commit hook rejected). Undo the staged untrack
      // and the .gitignore edit so we never leave a dirty index that would itself
      // wedge preFlightCheck. Safe because the precondition is a clean main.
      await g.resetHard();
      throw err;
    }

    // Best-effort publish: if it can't push now (offline / non-fast-forward) the
    // commit rides the next merge's safePush, and a local-only untrack commit
    // never wedges the loop. Pull-rebase on the next preflight replays it cleanly.
    try {
      await g.push('origin', kshetra.repo.mainBranch);
    } catch {
      /* ships on the next merge push */
    }
    return true;
  } catch {
    return false;
  }
}

// Append <entry> to the repo's .gitignore if not already present, creating the
// file when absent. Idempotent — a present entry is a no-op, so re-running never
// duplicates the line.
async function ensureGitignored(repoPath: string, entry: string): Promise<void> {
  const gitignorePath = join(repoPath, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    /* no .gitignore yet — appendFile creates it below */
  }
  const present = new Set(existing.split('\n').map(l => l.trim()));
  if (present.has(entry)) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(gitignorePath, `${sep}${entry}\n`, 'utf8');
}
