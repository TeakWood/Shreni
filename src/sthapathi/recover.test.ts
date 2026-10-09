import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// RECOVER on the engine is the work tree only: leases return interrupted work.

const calls: string[] = [];
const mockBranches = vi.fn<() => Promise<string[]>>();
const mockDeleteBranch = vi.fn<(b: string, o?: unknown) => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    resetHard: async () => { calls.push('resetHard'); },
    checkout: async (b: string) => { calls.push(`checkout ${b}`); },
    clean: async () => { calls.push('clean'); },
    branches: mockBranches,
    deleteBranch: mockDeleteBranch,
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
});
