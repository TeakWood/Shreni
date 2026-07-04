import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockCheckout = vi.fn<(ref: string) => Promise<void>>();
const mockMerge = vi.fn<(...args: string[]) => Promise<void>>();
const mockCommit = vi.fn<(message: string, ...args: string[]) => Promise<void>>();
const mockPush = vi.fn<(...args: string[]) => Promise<void>>();
const mockDeleteBranch = vi.fn<(branch: string) => Promise<void>>();
const mockClose = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    checkout: mockCheckout,
    merge: mockMerge,
    commit: mockCommit,
    push: mockPush,
    deleteBranch: mockDeleteBranch,
  })),
}));

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ close: mockClose })),
  syncBeads: mockSyncBeads,
}));

const mockDispatchParikshakaAsync = vi.fn();
vi.mock('./parikshaka-dispatch.js', () => ({ dispatchParikshakaAsync: mockDispatchParikshakaAsync }));

vi.mock('../kshetra/state.js', () => ({ clearBeadAttempts: vi.fn(), pauseKshetra: vi.fn() }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { squashMergeAndClose } = await import('./merge.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: {
    path: '/projects/myapp',
    remote: 'git@github.com:TeakWood/myapp.git',
    mainBranch: 'main',
    branchPattern: 'bead-{id}/{slug}',
  },
  beads: {
    path: '/projects/myapp-beads',
    remote: 'git@github.com:TeakWood/myapp-beads.git',
    mode: 'embedded',
  },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = {
  id: 'proj-42',
  slug: 'fix-auth',
  title: 'Fix auth',
  status: 'in_progress',
  priority: 2,
};

const OUTPUT: SilpiOutput = {
  filesChanged: [{ path: 'src/auth.ts', diff: '- old\n+ new' }],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth token refresh on 401',
  confidenceScore: 90,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckout.mockResolvedValue(undefined);
  mockMerge.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockPush.mockResolvedValue(undefined);
  mockDeleteBranch.mockResolvedValue(undefined);
  mockClose.mockResolvedValue('');
  mockSyncBeads.mockResolvedValue(undefined);
  mockDispatchParikshakaAsync.mockImplementation(() => {});
});

// ── squashMergeAndClose ───────────────────────────────────────────────────────

describe('squashMergeAndClose', () => {
  it('checks out the main branch first', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(mockCheckout).toHaveBeenCalledWith('main');
  });

  it('uses mainBranch from kshetra config', async () => {
    const kshetra = { ...KSHETRA, repo: { ...KSHETRA.repo, mainBranch: 'trunk' } };
    await squashMergeAndClose(TASK, kshetra, OUTPUT);
    expect(mockCheckout).toHaveBeenCalledWith('trunk');
  });

  it('merges the task branch with --squash', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(mockMerge).toHaveBeenCalledWith('--squash', 'bead-proj-42/fix-auth');
  });

  it('commits after merging', async () => {
    const order: string[] = [];
    mockMerge.mockImplementation(async () => { order.push('merge'); });
    mockCommit.mockImplementation(async () => { order.push('commit'); });
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(order.indexOf('merge')).toBeLessThan(order.indexOf('commit'));
  });

  it('commit message includes task title and id', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    const msg = (mockCommit.mock.calls[0] as unknown as [string])[0];
    expect(msg).toContain('Fix auth');
    expect(msg).toContain('proj-42');
  });

  it('commit message includes the summary', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    const msg = (mockCommit.mock.calls[0] as unknown as [string])[0];
    expect(msg).toContain('Fixed auth token refresh on 401');
  });

  it('pushes to origin/<mainBranch>', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(mockPush).toHaveBeenCalledWith('origin', 'main');
  });

  it('closes the task via bd with the task id', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(mockClose).toHaveBeenCalledWith('proj-42', expect.any(String));
  });

  it('close note contains confidence score', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    const note = (mockClose.mock.calls[0] as unknown as [string, string])[1];
    expect(note).toContain('confidence=90');
  });

  it('close note mentions number of files changed', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    const note = (mockClose.mock.calls[0] as unknown as [string, string])[1];
    expect(note).toContain('files=1');
  });

  it('calls syncBeads after closing the task', async () => {
    const order: string[] = [];
    mockClose.mockImplementation(async () => { order.push('close'); return ''; });
    mockSyncBeads.mockImplementation(async () => { order.push('sync'); });
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(order.indexOf('close')).toBeLessThan(order.indexOf('sync'));
  });

  it('deletes the task branch after syncing', async () => {
    const order: string[] = [];
    mockSyncBeads.mockImplementation(async () => { order.push('sync'); });
    mockDeleteBranch.mockImplementation(async () => { order.push('delete'); });
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(order.indexOf('sync')).toBeLessThan(order.indexOf('delete'));
  });

  it('force-deletes the correct branch (squash-merged branches are never "fully merged")', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-proj-42/fix-auth', { force: true });
  });

  it('push is called before bd close', async () => {
    const order: string[] = [];
    mockPush.mockImplementation(async () => { order.push('push'); });
    mockClose.mockImplementation(async () => { order.push('close'); return ''; });
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(order.indexOf('push')).toBeLessThan(order.indexOf('close'));
  });

  it('propagates errors thrown by merge', async () => {
    mockMerge.mockRejectedValue(new Error('conflict'));
    await expect(squashMergeAndClose(TASK, KSHETRA, OUTPUT)).rejects.toThrow('conflict');
  });

  it('does not call commit if merge fails', async () => {
    mockMerge.mockRejectedValue(new Error('conflict'));
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT).catch(() => {});
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('propagates errors thrown by push', async () => {
    mockPush.mockRejectedValue(new Error('remote rejected'));
    await expect(squashMergeAndClose(TASK, KSHETRA, OUTPUT)).rejects.toThrow('remote rejected');
  });

  it('does not delete branch if push fails', async () => {
    mockPush.mockRejectedValue(new Error('remote rejected'));
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT).catch(() => {});
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('dispatches Parikshaka asynchronously after push succeeds', async () => {
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT);
    expect(mockDispatchParikshakaAsync).toHaveBeenCalledWith(KSHETRA, TASK, OUTPUT);
  });

  it('does not dispatch Parikshaka when push fails', async () => {
    mockPush.mockRejectedValue(new Error('remote rejected'));
    await squashMergeAndClose(TASK, KSHETRA, OUTPUT).catch(() => {});
    expect(mockDispatchParikshakaAsync).not.toHaveBeenCalled();
  });
});