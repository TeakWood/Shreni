import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockLoadState = vi.fn<() => { kshetras: Record<string, unknown> }>();
vi.mock('../kshetra/state', () => ({ loadState: mockLoadState }));

const mockResumeKshetraById = vi.fn<(id: string) => unknown>();
vi.mock('./pause', () => ({ resumeKshetraById: mockResumeKshetraById }));

const mockCheckBaseBranch = vi.fn<() => Promise<{ exists: boolean }>>();
const mockCreateBaseBranch = vi.fn<() => Promise<{ branch: string; base: string }>>();
vi.mock('../sthapathi/base-branch', () => ({
  checkBaseBranch: mockCheckBaseBranch,
  createBaseBranch: mockCreateBaseBranch,
}));

// The reason constant is the only thing needed from pickup; stub the module so
// the test doesn't drag in the whole daemon dependency graph.
vi.mock('../sthapathi/pickup', () => ({ MISSING_BASE_BRANCH_REASON: 'missing-base-branch' }));

const { createBaseBranchForKshetra } = await import('./base-branch');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'develop', branchPattern: 'bead-{id}/{slug}' },
} as unknown as KshetraConfig;

const pausedForMissingBase = {
  kshetras: { myapp: { paused: true, reason: 'missing-base-branch', requiresManualResume: true } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadRegistry.mockReturnValue([KSHETRA]);
  mockLoadState.mockReturnValue(pausedForMissingBase);
  mockCheckBaseBranch.mockResolvedValue({ exists: false });
  mockCreateBaseBranch.mockResolvedValue({ branch: 'develop', base: 'main' });
  mockResumeKshetraById.mockReturnValue({ status: 'resumed', id: 'myapp' });
});

describe('createBaseBranchForKshetra', () => {
  it('creates the base branch and resumes when paused for a missing base', async () => {
    const result = await createBaseBranchForKshetra('myapp');
    expect(result).toEqual({ status: 'created', id: 'myapp', branch: 'develop', base: 'main' });
    expect(mockCreateBaseBranch).toHaveBeenCalledWith(KSHETRA);
    expect(mockResumeKshetraById).toHaveBeenCalledWith('myapp');
  });

  it('is idempotent: an out-of-band branch is treated as success + resume (no create)', async () => {
    mockCheckBaseBranch.mockResolvedValue({ exists: true });
    const result = await createBaseBranchForKshetra('myapp');
    expect(result).toEqual({ status: 'already_exists', id: 'myapp', branch: 'develop' });
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
    expect(mockResumeKshetraById).toHaveBeenCalledWith('myapp');
  });

  it('returns not_found for an unknown id (no create, no resume)', async () => {
    const result = await createBaseBranchForKshetra('ghost');
    expect(result).toEqual({ status: 'not_found', id: 'ghost' });
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
    expect(mockResumeKshetraById).not.toHaveBeenCalled();
  });

  it('refuses when the kshetra is not paused at all', async () => {
    mockLoadState.mockReturnValue({ kshetras: {} });
    const result = await createBaseBranchForKshetra('myapp');
    expect(result).toEqual({ status: 'not_paused_for_missing_base', id: 'myapp', reason: undefined });
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
    expect(mockResumeKshetraById).not.toHaveBeenCalled();
  });

  it('refuses (without clobbering) when paused for a different reason', async () => {
    mockLoadState.mockReturnValue({
      kshetras: { myapp: { paused: true, reason: 'stuck', requiresManualResume: true } },
    });
    const result = await createBaseBranchForKshetra('myapp');
    expect(result).toEqual({ status: 'not_paused_for_missing_base', id: 'myapp', reason: 'stuck' });
    expect(mockCreateBaseBranch).not.toHaveBeenCalled();
    expect(mockResumeKshetraById).not.toHaveBeenCalled();
  });
});
