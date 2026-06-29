import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = join(tmpdir(), `shreni-errors-test-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => dir };
});

// Mock bd + syncBeads so we don't need a real beads CLI
vi.mock('./beads.js', () => ({
  BeadsError: class BeadsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BeadsError';
    }
  },
  bd: () => ({
    addNote: vi.fn().mockResolvedValue('ok'),
    flag: vi.fn().mockResolvedValue('ok'),
  }),
  syncBeads: vi.fn().mockResolvedValue(undefined),
}));

// Mock git so branch cleanup doesn't touch a real repo
const mockBranchExists = vi.fn<() => Promise<boolean>>();
const mockCheckout = vi.fn<() => Promise<void>>();
const mockDeleteBranch = vi.fn<() => Promise<void>>();

vi.mock('./git.js', () => ({
  GitError: class GitError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly cause?: unknown,
    ) {
      super(message);
      this.name = 'GitError';
    }
  },
  git: vi.fn(() => ({
    branchExists: mockBranchExists,
    checkout: mockCheckout,
    deleteBranch: mockDeleteBranch,
  })),
}));

const { handleCycleError, cleanupBranch, ParseError, AgentError } = await import('./errors.js');
const { GitError } = await import('./git.js');
const { BeadsError } = await import('./beads.js');
const { loadState } = await import('../kshetra/state.js');

const KSHETRA = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/sishya-beads', remote: '' },
  agents: { maxRoundsPerBead: 5 },
} as unknown as import('../kshetra/config.js').KshetraConfig;

const TASK = {
  id: 'bead-abc',
  slug: 'fix-bug',
  title: 'Fix bug',
  status: 'in_progress' as const,
  priority: 1,
};

beforeEach(() => {
  mkdirSync(join(dir, '.shreni'), { recursive: true });
  mockBranchExists.mockReset().mockResolvedValue(true);
  mockCheckout.mockReset().mockResolvedValue(undefined);
  mockDeleteBranch.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  try { rmSync(join(dir, '.shreni'), { recursive: true }); } catch { /* ok */ }
});

describe('ParseError', () => {
  it('is an Error with name ParseError', () => {
    const e = new ParseError('bad json');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ParseError');
    expect(e.message).toBe('bad json');
  });
});

describe('AgentError', () => {
  it('captures kind and context', () => {
    const cause = new ParseError('bad');
    const e = new AgentError('MALFORMED_OUTPUT', { task: TASK, round: 1, cause });
    expect(e.kind).toBe('MALFORMED_OUTPUT');
    expect(e.context.round).toBe(1);
    expect(e.name).toBe('AgentError');
  });
});

describe('handleCycleError', () => {
  it('pauses kshetra with cooldown on API_DOWN (HTTP 503)', async () => {
    const apiErr = Object.assign(new Error('service unavailable'), { status: 503 });
    await handleCycleError(KSHETRA, TASK, apiErr);

    const state = loadState();
    expect(state.kshetras['sishya'].paused).toBe(true);
    expect(state.kshetras['sishya'].requiresManualResume).toBe(false);
    expect(state.kshetras['sishya'].reason).toBe('api_down');
  });

  it('pauses kshetra with cooldown on API_DOWN (ECONNRESET)', async () => {
    const netErr = new Error('ECONNRESET');
    await handleCycleError(KSHETRA, null, netErr);

    const state = loadState();
    expect(state.kshetras['sishya'].paused).toBe(true);
    expect(state.kshetras['sishya'].requiresManualResume).toBe(false);
  });

  it('blocks bead on AGENT_FAILED, does not pause kshetra', async () => {
    const agentErr = new AgentError('API_FAILURE', { task: TASK, round: 1 });
    await handleCycleError(KSHETRA, TASK, agentErr);

    const state = loadState();
    // Kshetra not paused
    expect(state.kshetras['sishya']?.paused).toBeFalsy();
  });

  it('blocks bead on MALFORMED_OUTPUT, does not pause kshetra', async () => {
    const parseErr = new AgentError('MALFORMED_OUTPUT', { task: TASK, round: 2 });
    await handleCycleError(KSHETRA, TASK, parseErr);

    const state = loadState();
    expect(state.kshetras['sishya']?.paused).toBeFalsy();
  });

  it('blocks bead and pauses manually on GIT_FAILED', async () => {
    const gitErr = new GitError('GIT_ERROR', 'Push rejected');
    await handleCycleError(KSHETRA, TASK, gitErr);

    const state = loadState();
    expect(state.kshetras['sishya'].paused).toBe(true);
    expect(state.kshetras['sishya'].requiresManualResume).toBe(true);
    expect(state.kshetras['sishya'].reason).toBe('git_failed');
  });

  it('pauses manually on BD_FAILED without touching bead', async () => {
    const bdErr = new (BeadsError as unknown as { new(msg: string): Error })('bd create failed');
    await handleCycleError(KSHETRA, null, bdErr);

    const state = loadState();
    expect(state.kshetras['sishya'].paused).toBe(true);
    expect(state.kshetras['sishya'].requiresManualResume).toBe(true);
    expect(state.kshetras['sishya'].reason).toBe('bd_failed');
  });

  it('handles unknown errors without pausing kshetra', async () => {
    const unknown = new Error('something unexpected');
    await handleCycleError(KSHETRA, TASK, unknown);

    const state = loadState();
    expect(state.kshetras['sishya']?.paused).toBeFalsy();
  });

  it('force-deletes the bead branch on AGENT_FAILED', async () => {
    await handleCycleError(KSHETRA, TASK, new AgentError('API_FAILURE', { task: TASK, round: 1 }));
    expect(mockCheckout).toHaveBeenCalledWith('main');
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-bead-abc/fix-bug', { force: true });
  });

  it('force-deletes the bead branch on MALFORMED_OUTPUT', async () => {
    await handleCycleError(KSHETRA, TASK, new AgentError('MALFORMED_OUTPUT', { task: TASK, round: 2 }));
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-bead-abc/fix-bug', { force: true });
  });

  it('deletes the bead branch on UNKNOWN errors', async () => {
    await handleCycleError(KSHETRA, TASK, new Error('something unexpected'));
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-bead-abc/fix-bug', { force: true });
  });

  it('deletes the bead branch on API_DOWN so the retry can recreate it', async () => {
    const apiErr = Object.assign(new Error('service unavailable'), { status: 503 });
    await handleCycleError(KSHETRA, TASK, apiErr);
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-bead-abc/fix-bug', { force: true });
  });

  it('KEEPS the branch on GIT_FAILED (for human inspection)', async () => {
    await handleCycleError(KSHETRA, TASK, new GitError('GIT_ERROR', 'Push rejected'));
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('does not attempt branch cleanup when there is no task (BD_FAILED)', async () => {
    const bdErr = new (BeadsError as unknown as { new(msg: string): Error })('bd create failed');
    await handleCycleError(KSHETRA, null, bdErr);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });
});

describe('cleanupBranch', () => {
  it('skips deletion when the branch does not exist', async () => {
    mockBranchExists.mockResolvedValue(false);
    await cleanupBranch(KSHETRA, TASK);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('checks out main before deleting (cannot delete the current branch)', async () => {
    const order: string[] = [];
    mockCheckout.mockImplementation(async () => { order.push('checkout'); });
    mockDeleteBranch.mockImplementation(async () => { order.push('delete'); });
    await cleanupBranch(KSHETRA, TASK);
    expect(order).toEqual(['checkout', 'delete']);
  });

  it('swallows cleanup failures so they never mask the original cycle error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockDeleteBranch.mockRejectedValue(new Error('branch is checked out elsewhere'));
    await expect(cleanupBranch(KSHETRA, TASK)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to clean up branch'));
    warn.mockRestore();
  });
});