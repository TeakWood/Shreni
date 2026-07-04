import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── git mock ──────────────────────────────────────────────────────────────

const mockHeadSha = vi.fn<(ref?: string) => Promise<string>>();
const mockCurrentBranch = vi.fn<() => Promise<string>>();
const mockCheckout = vi.fn<() => Promise<void>>();
const mockForceBranch = vi.fn<(name: string, ref: string) => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    headSha: (ref?: string) => mockHeadSha(ref),
    currentBranch: mockCurrentBranch,
    checkout: mockCheckout,
    forceBranch: mockForceBranch,
  })),
}));

const { captureGuard, assertOnBranch, recoverOffBranch, OffBranchError } = await import('./guard.js');

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'r', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'r', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};
const TASK: Task = { id: 'proj-7', slug: 'fix', title: 'Fix', status: 'in_progress', priority: 2 };
const BRANCH = 'bead-proj-7/fix';

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckout.mockResolvedValue(undefined);
  mockForceBranch.mockResolvedValue(undefined);
});

describe('captureGuard', () => {
  it('snapshots the current main sha', async () => {
    mockHeadSha.mockResolvedValue('main-aaa');
    const guard = await captureGuard(KSHETRA, BRANCH);
    expect(guard).toEqual({ branch: BRANCH, mainSha: 'main-aaa' });
    expect(mockHeadSha).toHaveBeenCalledWith('main');
  });
});

describe('assertOnBranch', () => {
  it('passes when on the bead branch and main is unchanged', async () => {
    mockCurrentBranch.mockResolvedValue(BRANCH);
    mockHeadSha.mockResolvedValue('main-aaa');
    await expect(assertOnBranch(KSHETRA, { branch: BRANCH, mainSha: 'main-aaa' })).resolves.toBeUndefined();
  });

  it('throws when HEAD has moved off the bead branch', async () => {
    mockCurrentBranch.mockResolvedValue('main');
    mockHeadSha.mockResolvedValue('main-aaa');
    await expect(assertOnBranch(KSHETRA, { branch: BRANCH, mainSha: 'main-aaa' }))
      .rejects.toBeInstanceOf(OffBranchError);
  });

  it('throws when main has acquired commits during the run', async () => {
    mockCurrentBranch.mockResolvedValue(BRANCH);
    mockHeadSha.mockResolvedValue('main-bbb'); // moved from main-aaa
    await expect(assertOnBranch(KSHETRA, { branch: BRANCH, mainSha: 'main-aaa' }))
      .rejects.toThrow(/main moved/);
  });
});

describe('recoverOffBranch', () => {
  it('returns to the bead branch and reports no salvage when main did not move', async () => {
    mockHeadSha.mockResolvedValue('main-aaa');
    const salvage = await recoverOffBranch(KSHETRA, TASK, { branch: BRANCH, mainSha: 'main-aaa' });
    expect(salvage).toBeNull();
    expect(mockCheckout).toHaveBeenCalledWith(BRANCH);
    expect(mockForceBranch).not.toHaveBeenCalled();
  });

  it('salvages stray commits and rewinds main when it diverged', async () => {
    mockHeadSha.mockResolvedValue('main-bbb'); // stray tip
    const salvage = await recoverOffBranch(KSHETRA, TASK, { branch: BRANCH, mainSha: 'main-aaa' });
    expect(salvage).toBe('shreni-salvage/proj-7');
    expect(mockCheckout).toHaveBeenCalledWith(BRANCH);
    // preserve stray commits, then restore main to origin
    expect(mockForceBranch).toHaveBeenNthCalledWith(1, 'shreni-salvage/proj-7', 'main-bbb');
    expect(mockForceBranch).toHaveBeenNthCalledWith(2, 'main', 'main-aaa');
  });
});
