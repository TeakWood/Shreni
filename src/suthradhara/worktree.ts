// Per-session git worktree for a Suthradhara intake session (ARD §4 —
// docs/ard/Shreni-ARD-Worktree-Isolation.md, in the Shreni-cloud repo). Phase 1
// gives the interview subprocess its OWN detached checkout so its frequent,
// high-collision reads — Read/Grep, and the read-only `git status/diff/show`
// allowlist — never observe (nor perturb) the shared build tree at repo.path
// while a Silpi is mid-edit there. Solves collision #1's read half by
// construction; the single design-doc write stays canonical at repo.path (see
// designdoc.ts / commit.ts and the note in §4.4).
//
// A worktree is detached, pinned to the current origin/<mainBranch>: Suthradhara
// never commits — it writes design docs (to repo.path, absolute) and files beads
// (via an absolute BEADS_DIR), so it needs a clean, private tree to read from,
// not a branch. The `.beads/` symlink is gitignored and therefore ABSENT from a
// fresh worktree, so the interview child MUST carry an absolute BEADS_DIR rather
// than trust cwd auto-discovery — session.ts sets it (ARD §4.4).
//
// Lifecycle (ARD §4.2, G5 crash-safety): created on session start (lifecycle.ts),
// torn down on session stop (lifecycle.ts stopSession), and `git worktree prune`d
// on runner startup (suthradhara-runner.ts) to reap admin entries whose dir a
// crash removed. Because only one live session runs per Kshetra (the pid file
// enforces it), any PRE-existing `suthradhara-*` worktree at start time is a leak
// from a dead session — startSession reaps them before creating a fresh one.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { shreniDir } from '../cli/pid';
import type { KshetraConfig } from '../kshetra/config';

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WorktreeError';
  }
}

// A git runner seam so the lifecycle is unit-testable without a real repo —
// mirrors the injectable-runner pattern in commit.ts. Returns trimmed stdout.
// The default shells out via execFile (no shell) with cwd bound to the caller.
export type GitRun = (args: string[], cwd: string) => Promise<string>;

const defaultRun: GitRun = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new WorktreeError(`git ${args[0]} failed: ${e.stderr ?? e.message ?? String(err)}`, err);
  }
};

// The directory prefix that marks a Suthradhara session worktree, so a leak
// sweep can find them without knowing session ids.
export const WORKTREE_PREFIX = 'suthradhara-';

// Worktree root lives OUTSIDE repo.path (ARD §3.1) — under ~/.shreni/worktrees/ —
// so a worktree directory is never itself an untracked entry inside the tracked
// tree (which would re-create collision #1).
export function worktreesRoot(kshetraId: string): string {
  return join(shreniDir(), 'worktrees', kshetraId);
}

export function sessionWorktreePath(kshetraId: string, sessionId: string): string {
  return join(worktreesRoot(kshetraId), WORKTREE_PREFIX + sessionId);
}

// Resolve the base ref to pin the detached worktree to: prefer a freshly-fetched
// origin/<mainBranch>; fall back to the local <mainBranch>, then HEAD, so a
// Kshetra without a reachable remote (or a test fixture) still gets a worktree.
// The fetch is best-effort — a transient network failure must not block starting
// an intake session (the tree is read-only; a slightly stale base is harmless).
async function resolveBaseRef(kshetra: KshetraConfig, run: GitRun): Promise<string> {
  const repo = kshetra.repo.path;
  const main = kshetra.repo.mainBranch;
  try {
    await run(['fetch', 'origin', main], repo);
  } catch {
    // offline / no remote — proceed against whatever refs are already local.
  }
  for (const ref of [`origin/${main}`, main]) {
    try {
      await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo);
      return ref;
    } catch {
      // ref not resolvable here; try the next fallback.
    }
  }
  return 'HEAD';
}

// Create (or re-create) the session's detached worktree pinned to origin/main and
// return its absolute path. Idempotent: an existing worktree at the same path
// (a resume, or a create racing a leak) is removed first, then re-added fresh —
// safe because Suthradhara holds no uncommitted state in the worktree.
export async function createSessionWorktree(
  kshetra: KshetraConfig,
  sessionId: string,
  run: GitRun = defaultRun,
): Promise<string> {
  const wtPath = sessionWorktreePath(kshetra.id, sessionId);
  mkdirSync(worktreesRoot(kshetra.id), { recursive: true });
  await removeWorktreeAt(kshetra, wtPath, run);
  const base = await resolveBaseRef(kshetra, run);
  await run(['worktree', 'add', wtPath, '--detach', base], kshetra.repo.path);
  return wtPath;
}

// Remove a single worktree by absolute path: ask git to detach + delete it, then
// belt-and-suspenders rm any directory git left behind (a leaked dir with a
// missing/half-written admin entry). Tolerant of a path git doesn't know and of a
// path that never existed — teardown must never throw over an already-clean state.
async function removeWorktreeAt(kshetra: KshetraConfig, wtPath: string, run: GitRun): Promise<void> {
  try {
    await run(['worktree', 'remove', wtPath, '--force'], kshetra.repo.path);
  } catch {
    // git doesn't know this path (never added, or admin already gone) — fall
    // through to the directory sweep + prune.
  }
  if (existsSync(wtPath)) {
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch (err) {
      throw new WorktreeError(`failed to remove worktree dir ${wtPath}`, err);
    }
  }
}

// Tear down one session's worktree (session stop). Precise by session id; the
// broad leak sweep is reapSessionWorktrees.
export async function removeSessionWorktree(
  kshetra: KshetraConfig,
  sessionId: string,
  run: GitRun = defaultRun,
): Promise<void> {
  await removeWorktreeAt(kshetra, sessionWorktreePath(kshetra.id, sessionId), run);
  await pruneWorktrees(kshetra, run);
}

// Reap EVERY Suthradhara worktree for a Kshetra + prune admin entries. Because
// only one intake session runs per Kshetra at a time, any `suthradhara-*` dir
// present here is a leak from a crashed/killed session — startSession calls this
// before creating a fresh worktree (G5), and stopSession calls it as a sweep.
// Returns the paths removed (for logging). Never throws over a missing root.
export async function reapSessionWorktrees(
  kshetra: KshetraConfig,
  run: GitRun = defaultRun,
): Promise<string[]> {
  const root = worktreesRoot(kshetra.id);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    entries = []; // root doesn't exist yet — nothing to reap.
  }
  for (const name of entries) {
    if (!name.startsWith(WORKTREE_PREFIX)) continue;
    const wtPath = join(root, name);
    await removeWorktreeAt(kshetra, wtPath, run);
    removed.push(wtPath);
  }
  await pruneWorktrees(kshetra, run);
  return removed;
}

// `git worktree prune` — reap admin entries under .git/worktrees/ whose working
// dir a crash removed. Cheap and safe: it never touches a live worktree (one
// whose dir still exists). Runner startup calls exactly this.
export async function pruneWorktrees(kshetra: KshetraConfig, run: GitRun = defaultRun): Promise<void> {
  try {
    await run(['worktree', 'prune'], kshetra.repo.path);
  } catch {
    // prune is a best-effort reap; a failure here must not block start/stop.
  }
}
