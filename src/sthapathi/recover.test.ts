import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// RECOVER on the engine is the work tree only: leases return interrupted work.

const calls: string[] = [];
const mockBranches = vi.fn<() => Promise<string[]>>();
const mockDeleteBranch = vi.fn<(b: string, o?: unknown) => Promise<void>>();
const mockLastCommit = vi.fn<(ref: string) => Promise<string>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    resetHard: async () => { calls.push('resetHard'); },
    checkout: async (b: string) => { calls.push(`checkout ${b}`); },
    clean: async () => { calls.push('clean'); },
    branches: mockBranches,
    deleteBranch: mockDeleteBranch,
    lastCommit: mockLastCommit,
  })),
}));

const { resetWorkTree } = await import('./recover.js');

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main' },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockBranches.mockResolvedValue([]);
  mockDeleteBranch.mockResolvedValue(undefined);
  mockLastCommit.mockImplementation(async ref => `abc123 work on ${ref}`);
});

describe('resetWorkTree', () => {
  it('resets the work tree to a clean main (resetHard → checkout main → clean)', async () => {
    await resetWorkTree(KSHETRA);
    expect(calls).toEqual(['resetHard', 'checkout main', 'clean']);
  });

  it('force-deletes every stale bead-* branch', async () => {
    mockBranches.mockResolvedValue(['bead-a/x', 'bead-b/y']);
    await resetWorkTree(KSHETRA);
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-a/x', { force: true });
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-b/y', { force: true });
  });

  it('keeps opts.keepBranch when invoked mid-run', async () => {
    mockBranches.mockResolvedValue(['bead-a/x', 'bead-b/y']);
    await resetWorkTree(KSHETRA, { keepBranch: 'bead-a/x' });
    expect(mockDeleteBranch).toHaveBeenCalledTimes(1);
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-b/y', { force: true });
  });

  // Shreni-beads-031a.19: recovery says what it discarded.
  it('returns each deleted branch with its last commit', async () => {
    mockBranches.mockResolvedValue(['bead-a/x', 'bead-b/y']);
    const discarded = await resetWorkTree(KSHETRA, { keepBranch: 'bead-b/y' });
    expect(discarded).toEqual([{ branch: 'bead-a/x', lastCommit: 'abc123 work on bead-a/x' }]);
  });
});
