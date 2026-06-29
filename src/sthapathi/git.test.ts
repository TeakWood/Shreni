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
