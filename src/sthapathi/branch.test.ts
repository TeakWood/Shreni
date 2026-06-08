import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── mock git ──────────────────────────────────────────────────────────────────

const mockCheckout = vi.fn<(ref: string) => Promise<void>>();
const mockPull = vi.fn<(...args: string[]) => Promise<void>>();
const mockCreateBranch = vi.fn<(task: Task) => Promise<string>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    checkout: mockCheckout,
    pull: mockPull,
    createBranch: mockCreateBranch,
  })),
}));

const { branchName, createTaskBranch } = await import('./branch.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: 'git@github.com:TeakWood/sishya.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: 'git@github.com:TeakWood/sishya-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = { id: 'proj-42', slug: 'fix-auth', title: 'Fix auth', status: 'pending', priority: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckout.mockResolvedValue(undefined);
  mockPull.mockResolvedValue(undefined);
  mockCreateBranch.mockResolvedValue(`bead-${TASK.id}/${TASK.slug}`);
});

// ── branchName ────────────────────────────────────────────────────────────────

describe('branchName', () => {
  it('returns bead-{id}/{slug}', () => {
    expect(branchName(TASK)).toBe('bead-proj-42/fix-auth');
  });

  it('preserves dots and dashes in the id segment', () => {
    const t: Task = { ...TASK, id: 'Shreni-beads-lwk.3', slug: 'git-branch-creation' };
    expect(branchName(t)).toBe('bead-Shreni-beads-lwk.3/git-branch-creation');
  });
});

// ── createTaskBranch ──────────────────────────────────────────────────────────

describe('createTaskBranch', () => {
  it('returns the branch name produced by createBranch', async () => {
    const result = await createTaskBranch(TASK, KSHETRA);
    expect(result).toBe('bead-proj-42/fix-auth');
  });

  it('calls checkout, pull, createBranch in that order', async () => {
    const order: string[] = [];
    mockCheckout.mockImplementation(async () => { order.push('checkout'); });
    mockPull.mockImplementation(async () => { order.push('pull'); });
    mockCreateBranch.mockImplementation(async () => { order.push('createBranch'); return 'x'; });

    await createTaskBranch(TASK, KSHETRA);

    expect(order).toEqual(['checkout', 'pull', 'createBranch']);
  });

  it('checks out the mainBranch from kshetra config', async () => {
    const kshetra = { ...KSHETRA, repo: { ...KSHETRA.repo, mainBranch: 'trunk' } };
    await createTaskBranch(TASK, kshetra);
    expect(mockCheckout).toHaveBeenCalledWith('trunk');
  });

  it('pulls with --rebase from origin/<mainBranch>', async () => {
    await createTaskBranch(TASK, KSHETRA);
    expect(mockPull).toHaveBeenCalledWith('--rebase', 'origin', 'main');
  });

  it('uses mainBranch from config in the pull call too', async () => {
    const kshetra = { ...KSHETRA, repo: { ...KSHETRA.repo, mainBranch: 'develop' } };
    await createTaskBranch(TASK, kshetra);
    expect(mockPull).toHaveBeenCalledWith('--rebase', 'origin', 'develop');
  });

  it('passes the full task object to createBranch', async () => {
    await createTaskBranch(TASK, KSHETRA);
    expect(mockCreateBranch).toHaveBeenCalledWith(TASK);
  });

  it('propagates errors thrown by checkout', async () => {
    mockCheckout.mockRejectedValue(new Error('detached HEAD'));
    await expect(createTaskBranch(TASK, KSHETRA)).rejects.toThrow('detached HEAD');
  });

  it('does not call pull if checkout fails', async () => {
    mockCheckout.mockRejectedValue(new Error('checkout failed'));
    await createTaskBranch(TASK, KSHETRA).catch(() => {});
    expect(mockPull).not.toHaveBeenCalled();
  });

  it('propagates errors thrown by pull', async () => {
    mockPull.mockRejectedValue(new Error('network unreachable'));
    await expect(createTaskBranch(TASK, KSHETRA)).rejects.toThrow('network unreachable');
  });

  it('does not call createBranch if pull fails', async () => {
    mockPull.mockRejectedValue(new Error('pull failed'));
    await createTaskBranch(TASK, KSHETRA).catch(() => {});
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });
});