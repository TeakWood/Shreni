import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { git, GitError } from './git.js';
import type { Task } from './types.js';

const execFileAsync = promisify(execFile);

// Integration tests using a real git repo in a temp directory
let repoDir: string;

async function gitCmd(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoDir });
  return stdout.trim();
}

async function initRepo() {
  await execFileAsync('git', ['init', '-b', 'main', repoDir]);
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# test');
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

beforeEach(async () => {
  repoDir = join(tmpdir(), `shreni-git-test-${process.pid}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  await initRepo();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(`${repoDir}-origin.git`, { recursive: true, force: true });
});

describe('git() helper', () => {
  it('status() returns empty lists on a clean repo', async () => {
    const g = git(repoDir);
    const status = await g.status();
    expect(status.modified).toEqual([]);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it('status() detects modified and untracked files', async () => {
    writeFileSync(join(repoDir, 'README.md'), 'changed');
    writeFileSync(join(repoDir, 'new.txt'), 'new');
    const g = git(repoDir);
    const status = await g.status();
    expect(status.modified).toContain('README.md');
    expect(status.untracked).toContain('new.txt');
  });

  it('add() and commit() create a new commit', async () => {
    const g = git(repoDir);
    writeFileSync(join(repoDir, 'file.txt'), 'hello');
    await g.add('-A');
    await g.commit('test commit');
    const log = await gitCmd('log', '--oneline');
    expect(log).toContain('test commit');
  });

  it('commit() is a no-op on a clean tree (does not throw)', async () => {
    const g = git(repoDir);
    await g.add('-A');
    await expect(g.commit('empty commit')).resolves.not.toThrow();
  });

  it('checkout() switches branches', async () => {
    const g = git(repoDir);
    await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repoDir });
    await g.checkout('main');
    const branch = await gitCmd('branch', '--show-current');
    expect(branch).toBe('main');
  });

  it('createBranch() creates and checks out a bead branch', async () => {
    const g = git(repoDir);
    const task: Task = { id: 'abc123', slug: 'fix-login', title: 'Fix login', status: 'pending', priority: 1 };
    const branch = await g.createBranch(task);
    expect(branch).toBe('bead-abc123/fix-login');
    const current = await gitCmd('branch', '--show-current');
    expect(current).toBe('bead-abc123/fix-login');
  });

  it('branchExists() returns true for existing branch, false otherwise', async () => {
    const g = git(repoDir);
    expect(await g.branchExists('main')).toBe(true);
    expect(await g.branchExists('no-such-branch')).toBe(false);
  });

  it('branches() lists local branches, filtered by prefix', async () => {
    const g = git(repoDir);
    await execFileAsync('git', ['branch', 'bead-1/a'], { cwd: repoDir });
    await execFileAsync('git', ['branch', 'bead-2/b'], { cwd: repoDir });
    await execFileAsync('git', ['branch', 'feature'], { cwd: repoDir });
    expect((await g.branches()).sort()).toEqual(['bead-1/a', 'bead-2/b', 'feature', 'main']);
    expect((await g.branches('bead-')).sort()).toEqual(['bead-1/a', 'bead-2/b']);
  });

  it('resetHard() discards tracked changes', async () => {
    const g = git(repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'uncommitted change');
    await g.resetHard();
    const status = await g.status();
    expect(status.modified).toEqual([]);
  });

  it('discardPath() reverts a tracked file and is a no-op on untracked/absent paths', async () => {
    const g = git(repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'uncommitted change');
    await g.discardPath('README.md');
    const { readFileSync } = await import('fs');
    expect(readFileSync(join(repoDir, 'README.md'), 'utf8')).toBe('# test');
    // best-effort: an untracked / absent path does not throw
    writeFileSync(join(repoDir, 'untracked.txt'), 'x');
    await expect(g.discardPath('untracked.txt')).resolves.toBeUndefined();
    await expect(g.discardPath('does-not-exist.txt')).resolves.toBeUndefined();
  });

  it('isTracked() distinguishes tracked, untracked, and absent paths', async () => {
    const g = git(repoDir);
    expect(await g.isTracked('README.md')).toBe(true);
    writeFileSync(join(repoDir, 'untracked.txt'), 'x');
    expect(await g.isTracked('untracked.txt')).toBe(false);
    expect(await g.isTracked('nope.txt')).toBe(false);
  });

  it('rmCached() untracks a file without deleting it from the working tree', async () => {
    const g = git(repoDir);
    await g.rmCached('README.md');
    const { existsSync } = await import('fs');
    expect(existsSync(join(repoDir, 'README.md'))).toBe(true); // still on disk
    expect(await g.isTracked('README.md')).toBe(false); // no longer in the index
    const status = await g.status();
    expect(status.staged).toContain('README.md'); // staged deletion pending commit
  });

  it('clean() removes untracked files but keeps ignored ones', async () => {
    const g = git(repoDir);
    writeFileSync(join(repoDir, '.gitignore'), 'ignored.txt\n');
    await g.add('-A');
    await g.commit('add gitignore');
    writeFileSync(join(repoDir, 'untracked.txt'), 'x');
    writeFileSync(join(repoDir, 'ignored.txt'), 'y');
    await g.clean();
    const status = await g.status();
    expect(status.untracked).not.toContain('untracked.txt');
    // ignored files are left alone (clean without -x)
    const { readFileSync } = await import('fs');
    expect(readFileSync(join(repoDir, 'ignored.txt'), 'utf8')).toBe('y');
  });

  it('currentBranch() returns the checked-out branch name', async () => {
    const g = git(repoDir);
    expect(await g.currentBranch()).toBe('main');
    await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repoDir });
    expect(await g.currentBranch()).toBe('feature');
  });

  it('headSha() resolves a ref to its sha and matches rev-parse', async () => {
    const g = git(repoDir);
    expect(await g.headSha('main')).toBe(await gitCmd('rev-parse', 'main'));
  });

  it('forceBranch() moves a branch ref without checking it out', async () => {
    const g = git(repoDir);
    const base = await gitCmd('rev-parse', 'main');
    await execFileAsync('git', ['checkout', '-b', 'work'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'c.txt'), 'c');
    await g.add('-A');
    await g.commit('on work');
    const workTip = await gitCmd('rev-parse', 'work');

    // point main at work's tip while staying on 'work'
    await g.forceBranch('main', workTip);
    expect(await g.currentBranch()).toBe('work');
    expect(await gitCmd('rev-parse', 'main')).toBe(workTip);

    // and rewind it back
    await g.forceBranch('main', base);
    expect(await gitCmd('rev-parse', 'main')).toBe(base);
  });

  it('isAncestor() returns true when first is ancestor of second', async () => {
    const g = git(repoDir);
    const firstCommit = await gitCmd('rev-parse', 'HEAD');
    writeFileSync(join(repoDir, 'b.txt'), 'b');
    await g.add('-A');
    await g.commit('second commit');

    expect(await g.isAncestor(firstCommit, 'HEAD')).toBe(true);
    expect(await g.isAncestor('HEAD', firstCommit)).toBe(false);
  });

  it('revsBetween() returns commits between two refs', async () => {
    const g = git(repoDir);
    const base = await gitCmd('rev-parse', 'HEAD');

    await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'f.txt'), 'feature');
    await g.add('-A');
    await g.commit('feature commit');

    const commits = await g.revsBetween(base, 'HEAD');
    expect(commits).toHaveLength(1);
  });

  it('commitFile() stages a single file and commits', async () => {
    const g = git(repoDir);
    writeFileSync(join(repoDir, 'e2e.test.ts'), 'test');
    await g.commitFile('e2e.test.ts', 'e2e: add test');
    const log = await gitCmd('log', '--oneline');
    expect(log).toContain('e2e: add test');
  });

  it('deleteBranch() removes a local branch', async () => {
    const g = git(repoDir);
    await execFileAsync('git', ['checkout', '-b', 'to-delete'], { cwd: repoDir });
    await g.checkout('main');
    await g.deleteBranch('to-delete');
    expect(await g.branchExists('to-delete')).toBe(false);
  });

  it('deleteBranch() refuses an unmerged branch without force', async () => {
    const g = git(repoDir);
    await execFileAsync('git', ['checkout', '-b', 'unmerged'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'wip.ts'), 'partial work');
    await g.commitFile('wip.ts', 'wip: partial');
    await g.checkout('main');
    await expect(g.deleteBranch('unmerged')).rejects.toThrow(GitError);
    expect(await g.branchExists('unmerged')).toBe(true);
  });

  it('deleteBranch({ force: true }) removes an unmerged branch', async () => {
    const g = git(repoDir);
    await execFileAsync('git', ['checkout', '-b', 'unmerged'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'wip.ts'), 'partial work');
    await g.commitFile('wip.ts', 'wip: partial');
    await g.checkout('main');
    await g.deleteBranch('unmerged', { force: true });
    expect(await g.branchExists('unmerged')).toBe(false);
  });

  // --- remote base-branch primitives (Shreni-beads-uvu.1) ---

  // Stand up a bare repo as `origin`, push the working repo's `main`, and (when
  // asked) create/point a distinct default branch. Returns the bare repo path.
  async function addOrigin(opts: { defaultBranch?: string } = {}): Promise<string> {
    const bare = `${repoDir}-origin.git`;
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
    await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: repoDir });
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: repoDir });
    if (opts.defaultBranch && opts.defaultBranch !== 'main') {
      await execFileAsync('git', ['branch', opts.defaultBranch], { cwd: repoDir });
      await execFileAsync('git', ['push', 'origin', opts.defaultBranch], { cwd: repoDir });
      // Point the bare repo's HEAD at the distinct default, then mirror it locally.
      await execFileAsync('git', ['symbolic-ref', 'HEAD', `refs/heads/${opts.defaultBranch}`], { cwd: bare });
    }
    await execFileAsync('git', ['remote', 'set-head', 'origin', '-a'], { cwd: repoDir });
    return bare;
  }

  it('remoteBranchExists() reflects branch presence on origin', async () => {
    await addOrigin();
    const g = git(repoDir);
    expect(await g.remoteBranchExists('main')).toBe(true);
    expect(await g.remoteBranchExists('no-such-branch')).toBe(false);
  });

  it('remoteBranchExists() does not suffix-match a nested branch', async () => {
    const bare = await addOrigin();
    const g = git(repoDir);
    // push feature/trunk but NOT a top-level trunk — a bare `trunk` ls-remote
    // pattern would spuriously match refs/heads/feature/trunk.
    await execFileAsync('git', ['branch', 'feature/trunk'], { cwd: repoDir });
    await execFileAsync('git', ['push', 'origin', 'feature/trunk'], { cwd: repoDir });
    expect(await g.remoteBranchExists('trunk')).toBe(false);
    expect(await g.remoteBranchExists('feature/trunk')).toBe(true);
    expect(bare).toContain('-origin.git');
  });

  it('originDefaultBranch() resolves via symbolic-ref', async () => {
    await addOrigin({ defaultBranch: 'trunk' });
    const g = git(repoDir);
    expect(await g.originDefaultBranch()).toBe('trunk');
  });

  it('originDefaultBranch() falls back to main with no origin/HEAD and no gh', async () => {
    // no remote at all → symbolic-ref fails, gh repo view fails → literal 'main'
    const g = git(repoDir);
    expect(await g.originDefaultBranch()).toBe('main');
  });

  it('createBaseBranch() cuts from origin default and pushes', async () => {
    const bare = await addOrigin();
    const g = git(repoDir);
    await g.createBaseBranch('release', 'main');
    const heads = await execFileAsync('git', ['ls-remote', '--heads', bare, 'release']);
    expect(heads.stdout.trim().length).toBeGreaterThan(0);
    // cut from origin/main → same tip
    const mainSha = await gitCmd('rev-parse', 'origin/main');
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', bare, 'release']);
    expect(stdout).toContain(mainSha);
  });

  it('createBaseBranch() is idempotent when the branch already exists on origin', async () => {
    await addOrigin();
    const g = git(repoDir);
    await g.createBaseBranch('release', 'main'); // first create + push
    // second call: remote branch already exists → must not throw
    await expect(g.createBaseBranch('release', 'main')).resolves.toBeUndefined();
  });

  it('createBaseBranch() cuts from origin, not a stale same-named local branch', async () => {
    const bare = await addOrigin();
    const g = git(repoDir);
    // a local `release` pointing at a DIFFERENT commit that was never pushed —
    // the branch-that-exists-locally-but-not-on-origin scenario the epic targets
    await execFileAsync('git', ['checkout', '-b', 'release'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'stale.txt'), 'stale');
    await g.add('-A');
    await g.commit('stale local commit');
    const staleSha = await gitCmd('rev-parse', 'release');
    await g.checkout('main');

    await g.createBaseBranch('release', 'main');
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', bare, 'release']);
    const mainSha = await gitCmd('rev-parse', 'origin/main');
    expect(stdout).toContain(mainSha); // origin/main tip, NOT the stale local commit
    expect(stdout).not.toContain(staleSha);
  });

  it('createBaseBranch() treats an out-of-band remote branch as success', async () => {
    const bare = await addOrigin();
    const g = git(repoDir);
    // someone else creates origin/release at a DIVERGENT commit between our
    // check and our push → our push is rejected; we must treat it as success.
    await execFileAsync('git', ['checkout', '-b', 'release'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'other.txt'), 'other');
    await g.add('-A');
    await g.commit('divergent out-of-band commit');
    await execFileAsync('git', ['push', 'origin', 'release'], { cwd: repoDir });
    await g.checkout('main');

    await expect(g.createBaseBranch('release', 'main')).resolves.toBeUndefined();
    expect(bare).toContain('-origin.git');
  });

  it('throws GitError on invalid git commands', async () => {
    const g = git(repoDir);
    await expect(g.checkout('no-such-branch')).rejects.toThrow(GitError);
  });

  it('GitError includes the git error code', async () => {
    const g = git('/nonexistent/path');
    try {
      await g.status();
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('GIT_ERROR');
    }
  });
});
