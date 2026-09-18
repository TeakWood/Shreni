import { describe, it, expect, vi } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import { checkBaseBranch, createBaseBranch, type BaseBranchGit } from './base-branch.js';

function ksh(mainBranch = 'main'): KshetraConfig {
  return {
    id: 'myapp',
    repo: { path: '/projects/myapp', mainBranch },
  } as unknown as KshetraConfig;
}

// A fake git wrapper (only the base-branch primitives) — no real remote needed.
function fakeGit(overrides: Partial<BaseBranchGit> = {}): BaseBranchGit {
  return {
    remoteBranchExists: vi.fn(async () => false),
    originDefaultBranch: vi.fn(async () => 'main'),
    createBaseBranch: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('checkBaseBranch', () => {
  it('reflects remote existence of repo.mainBranch', async () => {
    const remoteBranchExists = vi.fn(async () => true);
    const g = fakeGit({ remoteBranchExists });
    const result = await checkBaseBranch(ksh('trunk'), g);
    expect(result).toEqual({ exists: true });
    expect(remoteBranchExists).toHaveBeenCalledWith('trunk');
  });

  it('reports exists=false when the branch is absent on origin', async () => {
    const g = fakeGit({ remoteBranchExists: vi.fn(async () => false) });
    expect(await checkBaseBranch(ksh('release'), g)).toEqual({ exists: false });
  });
});

describe('createBaseBranch', () => {
  it('creates repo.mainBranch from origin default and reports both', async () => {
    const createFn = vi.fn(async () => {});
    const g = fakeGit({
      originDefaultBranch: vi.fn(async () => 'main'),
      createBaseBranch: createFn,
    });
    const result = await createBaseBranch(ksh('release'), g);
    expect(result).toEqual({ branch: 'release', base: 'main' });
    expect(createFn).toHaveBeenCalledWith('release', 'main');
  });

  it('cuts from whatever origin default resolves to (not hardcoded main)', async () => {
    const createFn = vi.fn(async () => {});
    const g = fakeGit({
      originDefaultBranch: vi.fn(async () => 'trunk'),
      createBaseBranch: createFn,
    });
    const result = await createBaseBranch(ksh('release'), g);
    expect(result.base).toBe('trunk');
    expect(createFn).toHaveBeenCalledWith('release', 'trunk');
  });
});
