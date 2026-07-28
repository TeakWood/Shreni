import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

const mockExistsSync = vi.fn<(p: string) => boolean>();
const mockMkdirSync = vi.fn();
const mockReaddirSync = vi.fn<(p: string) => string[]>();
const mockRmSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (p: string) => mockExistsSync(p),
  mkdirSync: (p: string, o?: unknown) => mockMkdirSync(p, o),
  readdirSync: (p: string) => mockReaddirSync(p),
  rmSync: (p: string, o?: unknown) => mockRmSync(p, o),
}));

vi.mock('../cli/pid', () => ({
  shreniDir: () => '/home/.shreni',
}));

const {
  worktreesRoot,
  sessionWorktreePath,
  WORKTREE_PREFIX,
  createSessionWorktree,
  removeSessionWorktree,
  reapSessionWorktrees,
  pruneWorktrees,
} = await import('./worktree');

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: 'origin', mainBranch: 'main' },
} as unknown as KshetraConfig;

const SID = 'myapp-20260727T140312-a3f2';

// A recording git runner: succeeds by default, drives specific failures per-arg
// via `fail`, so a test can simulate "origin/main not resolvable" etc.
function makeRun(fail?: (args: string[]) => boolean) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[], _cwd: string) => {
    calls.push(args);
    if (fail?.(args)) throw new Error(`git ${args[0]} failed`);
    return '';
  });
  return { run, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
});

describe('path helpers', () => {
  it('roots worktrees under ~/.shreni/worktrees/<kshetra-id> (outside repo.path)', () => {
    expect(worktreesRoot('myapp')).toBe('/home/.shreni/worktrees/myapp');
  });

  it('names the session dir with the suthradhara- prefix', () => {
    expect(sessionWorktreePath('myapp', SID)).toBe(
      `/home/.shreni/worktrees/myapp/${WORKTREE_PREFIX}${SID}`,
    );
  });
});

describe('createSessionWorktree', () => {
  it('fetches origin, pins the detached worktree to origin/main, and returns its path', async () => {
    const { run, calls } = makeRun();
    const wt = await createSessionWorktree(KSHETRA, SID, run);

    expect(wt).toBe(sessionWorktreePath('myapp', SID));
    expect(mockMkdirSync).toHaveBeenCalledWith('/home/.shreni/worktrees/myapp', { recursive: true });
    expect(calls).toContainEqual(['fetch', 'origin', 'main']);
    // origin/main resolves (default success), so it becomes the detached base.
    expect(calls).toContainEqual(['worktree', 'add', wt, '--detach', 'origin/main']);
  });

  it('falls back to local main when origin/main is not resolvable', async () => {
    // Fail the origin/main rev-parse only; the local `main` rev-parse succeeds.
    const { run, calls } = makeRun(
      (args) => args[0] === 'rev-parse' && args.includes('origin/main^{commit}'),
    );
    await createSessionWorktree(KSHETRA, SID, run);
    const add = calls.find((c) => c[0] === 'worktree' && c[1] === 'add');
    expect(add?.[add.length - 1]).toBe('main');
  });

  it('proceeds when the best-effort fetch fails (offline)', async () => {
    const { run, calls } = makeRun((args) => args[0] === 'fetch');
    await expect(createSessionWorktree(KSHETRA, SID, run)).resolves.toBeTruthy();
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(true);
  });

  it('removes a stale worktree at the same path before adding (idempotent resume)', async () => {
    const { run, calls } = makeRun();
    await createSessionWorktree(KSHETRA, SID, run);
    const wt = sessionWorktreePath('myapp', SID);
    // remove-before-add: the `worktree remove` for this path precedes `worktree add`.
    const removeIdx = calls.findIndex((c) => c[0] === 'worktree' && c[1] === 'remove' && c[2] === wt);
    const addIdx = calls.findIndex((c) => c[0] === 'worktree' && c[1] === 'add');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeLessThan(addIdx);
  });
});

describe('removeSessionWorktree', () => {
  it('removes the session worktree and prunes admin entries', async () => {
    const { run, calls } = makeRun();
    await removeSessionWorktree(KSHETRA, SID, run);
    const wt = sessionWorktreePath('myapp', SID);
    expect(calls).toContainEqual(['worktree', 'remove', wt, '--force']);
    expect(calls).toContainEqual(['worktree', 'prune']);
  });

  it('rm -rfs a leaked directory git no longer tracks', async () => {
    // git remove fails (unknown path) but the dir still exists → fs sweep.
    mockExistsSync.mockReturnValue(true);
    const { run } = makeRun((args) => args[0] === 'worktree' && args[1] === 'remove');
    await removeSessionWorktree(KSHETRA, SID, run);
    expect(mockRmSync).toHaveBeenCalledWith(
      sessionWorktreePath('myapp', SID),
      { recursive: true, force: true },
    );
  });
});

describe('reapSessionWorktrees', () => {
  it('removes every suthradhara-* worktree and ignores foreign dirs', async () => {
    mockReaddirSync.mockReturnValue([
      `${WORKTREE_PREFIX}s1`,
      `${WORKTREE_PREFIX}s2`,
      'bead-42-slug', // a Sthapathi worktree — must be left alone
      'README.md',
    ]);
    const { run, calls } = makeRun();
    const removed = await reapSessionWorktrees(KSHETRA, run);

    expect(removed).toEqual([
      `/home/.shreni/worktrees/myapp/${WORKTREE_PREFIX}s1`,
      `/home/.shreni/worktrees/myapp/${WORKTREE_PREFIX}s2`,
    ]);
    const removeArgs = calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove').map((c) => c[2]);
    expect(removeArgs).toEqual(removed);
    expect(calls).toContainEqual(['worktree', 'prune']);
  });

  it('is a no-op (still prunes) when the worktree root does not exist', async () => {
    mockReaddirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { run, calls } = makeRun();
    const removed = await reapSessionWorktrees(KSHETRA, run);
    expect(removed).toEqual([]);
    expect(calls).toEqual([['worktree', 'prune']]);
  });
});

describe('pruneWorktrees', () => {
  it('runs git worktree prune', async () => {
    const { run, calls } = makeRun();
    await pruneWorktrees(KSHETRA, run);
    expect(calls).toEqual([['worktree', 'prune']]);
  });

  it('swallows a prune failure (best-effort reap)', async () => {
    const { run } = makeRun((args) => args[0] === 'worktree');
    await expect(pruneWorktrees(KSHETRA, run)).resolves.toBeUndefined();
  });
});
