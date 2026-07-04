import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── temp dir for state.json writes ───────────────────────────────────────────

const dir = join(tmpdir(), `shreni-merge-safe-test-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => dir };
});

// ── git mock ──────────────────────────────────────────────────────────────────

const mockCheckout = vi.fn<() => Promise<void>>();
const mockFetch = vi.fn<() => Promise<void>>();
const mockPull = vi.fn<() => Promise<void>>();
const mockPush = vi.fn<() => Promise<void>>();
const mockMerge = vi.fn<() => Promise<void>>();
const mockCommit = vi.fn<() => Promise<void>>();
const mockRebase = vi.fn<() => Promise<void>>();
const mockRevsBetween = vi.fn<() => Promise<string[]>>();
const mockMergeTree = vi.fn<() => Promise<string[]>>();

vi.mock('./git.js', () => ({
  GitError: class GitError extends Error {
    constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
      super(message);
      this.name = 'GitError';
    }
  },
  git: vi.fn(() => ({
    checkout: mockCheckout,
    fetch: mockFetch,
    pull: mockPull,
    push: mockPush,
    merge: mockMerge,
    commit: mockCommit,
    rebase: mockRebase,
    revsBetween: mockRevsBetween,
    mergeTree: mockMergeTree,
  })),
}));

// ── beads mock ────────────────────────────────────────────────────────────────

const mockBdAddNote = vi.fn<() => Promise<string>>();
const mockBdFlag = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ addNote: mockBdAddNote, flag: mockBdFlag })),
  syncBeads: mockSyncBeads,
}));

vi.mock('./errors.js', () => ({
  notifyOperator: vi.fn().mockResolvedValue(undefined),
  AgentError: class AgentError extends Error {},
  ParseError: class ParseError extends Error {},
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { safePush, safeMerge, handleMergeConflict } = await import('./merge.js');
const { GitError } = await import('./git.js');
const { loadState } = await import('../kshetra/state.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads', remote: '' },
  agents: { maxRoundsPerBead: 3 },
} as unknown as KshetraConfig;

const TASK: Task = {
  id: 'bead-42',
  slug: 'fix-bug',
  title: 'Fix bug',
  status: 'in_progress',
  priority: 1,
  round: 1,
  context: { relatedFiles: ['src/auth.ts'] },
};

beforeEach(() => {
  mkdirSync(join(dir, '.shreni'), { recursive: true });
  vi.clearAllMocks();
  mockCheckout.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue(undefined);
  mockPull.mockResolvedValue(undefined);
  mockPush.mockResolvedValue(undefined);
  mockMerge.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockRebase.mockResolvedValue(undefined);
  mockRevsBetween.mockResolvedValue([]);
  mockMergeTree.mockResolvedValue([]);
  mockBdAddNote.mockResolvedValue('ok');
  mockBdFlag.mockResolvedValue('ok');
  mockSyncBeads.mockResolvedValue(undefined);
});

afterEach(() => {
  try { rmSync(join(dir, '.shreni'), { recursive: true }); } catch { /* ok */ }
});

// ── safePush ──────────────────────────────────────────────────────────────────

describe('safePush', () => {
  it('pushes to origin/main on success', async () => {
    await safePush(KSHETRA, TASK);
    expect(mockPush).toHaveBeenCalledWith('origin', 'main');
  });

  it('pull-rebases and retries on non-fast-forward rejection', async () => {
    mockPush
      .mockRejectedValueOnce(new Error('non-fast-forward'))
      .mockResolvedValueOnce(undefined);

    await safePush(KSHETRA, TASK);
    expect(mockPull).toHaveBeenCalledWith('--rebase', 'origin', 'main');
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('adds note on non-fast-forward retry', async () => {
    mockPush
      .mockRejectedValueOnce(new Error('non-fast-forward'))
      .mockResolvedValueOnce(undefined);

    await safePush(KSHETRA, TASK);
    expect(mockBdAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('non-fast-forward'),
    );
  });

  it('throws GitError PUSH_FAILED when retry also fails', async () => {
    mockPush.mockRejectedValue(new Error('non-fast-forward'));

    await expect(safePush(KSHETRA, TASK)).rejects.toSatisfy(
      (e: unknown) => e instanceof GitError && (e as InstanceType<typeof GitError>).code === 'PUSH_FAILED',
    );
  });

  it('rethrows non-fast-forward unrelated errors immediately', async () => {
    mockPush.mockRejectedValue(new Error('authentication failed'));
    await expect(safePush(KSHETRA, TASK)).rejects.toThrow('authentication failed');
    expect(mockPull).not.toHaveBeenCalled();
  });
});

// ── safeMerge ─────────────────────────────────────────────────────────────────

describe('safeMerge', () => {
  it('fetches origin/main before merging', async () => {
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockFetch).toHaveBeenCalledWith('origin', 'main');
  });

  it('skips rebase when main has not moved', async () => {
    mockRevsBetween.mockResolvedValue([]);
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockRebase).not.toHaveBeenCalled();
  });

  it('rebases branch when main has moved', async () => {
    mockRevsBetween.mockResolvedValue(['abc123']);
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockRebase).toHaveBeenCalledWith('origin/main');
  });

  it('squash-merges after no conflicts', async () => {
    mockMergeTree.mockResolvedValue([]);
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockMerge).toHaveBeenCalledWith('--squash', 'bead-42/fix-bug');
  });

  it('commits after squash merge', async () => {
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockCommit).toHaveBeenCalledWith(expect.stringContaining('bead-42'));
  });

  it('calls safePush after squash merge', async () => {
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockPush).toHaveBeenCalledWith('origin', 'main');
  });

  it('calls handleMergeConflict and skips squash when conflicts found', async () => {
    mockMergeTree.mockResolvedValue(['src/auth.ts']);
    await safeMerge(KSHETRA, TASK, 'bead-42/fix-bug');
    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('aborts rebase and rethrows on rebase failure', async () => {
    mockRevsBetween.mockResolvedValue(['abc123']);
    mockRebase.mockRejectedValueOnce(new Error('conflict during rebase'));

    await expect(safeMerge(KSHETRA, TASK, 'bead-42/fix-bug')).rejects.toSatisfy(
      (e: unknown) => e instanceof GitError && (e as InstanceType<typeof GitError>).code === 'REBASE_FAILED',
    );
    // --abort rebase call should have happened
    expect(mockRebase).toHaveBeenCalledWith('--abort');
  });
});

// ── handleMergeConflict ───────────────────────────────────────────────────────

describe('handleMergeConflict', () => {
  it('blocks bead and pauses kshetra on out-of-scope conflict', async () => {
    const outOfScopeConflict = ['src/unrelated.ts']; // not in task.context.relatedFiles
    await handleMergeConflict(KSHETRA, TASK, 'bead-42/fix-bug', outOfScopeConflict);

    expect(mockBdFlag).toHaveBeenCalledWith('bead-42', expect.stringContaining('outside task scope'));
    const state = loadState();
    expect(state.kshetras['myapp'].paused).toBe(true);
    expect(state.kshetras['myapp'].requiresManualResume).toBe(true);
  });

  it('adds conflict-context note for in-scope conflict when rounds remain', async () => {
    const inScopeConflict = ['src/auth.ts']; // in task.context.relatedFiles
    await handleMergeConflict(KSHETRA, TASK, 'bead-42/fix-bug', inScopeConflict);

    expect(mockBdAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('re-dispatching Silpi with conflict context'),
    );
    expect(mockBdFlag).not.toHaveBeenCalled();
  });

  it('blocks bead and pauses on in-scope conflict when max rounds exceeded', async () => {
    const maxedTask: Task = { ...TASK, round: 3 }; // round === maxRoundsPerBead
    const inScopeConflict = ['src/auth.ts'];
    await handleMergeConflict(KSHETRA, maxedTask, 'bead-42/fix-bug', inScopeConflict);

    expect(mockBdFlag).toHaveBeenCalledWith('bead-42', expect.stringContaining('Merge conflict after max rounds'));
    const state = loadState();
    expect(state.kshetras['myapp'].paused).toBe(true);
    expect(state.kshetras['myapp'].requiresManualResume).toBe(true);
  });

  it('does not pause kshetra on in-scope conflict with rounds remaining', async () => {
    const inScopeConflict = ['src/auth.ts'];
    await handleMergeConflict(KSHETRA, TASK, 'bead-42/fix-bug', inScopeConflict);

    const state = loadState();
    expect(state.kshetras['myapp']?.paused).toBeFalsy();
  });
});