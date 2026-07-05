import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockCheckout = vi.fn<(ref: string) => Promise<void>>();
const mockPush = vi.fn<(...args: string[]) => Promise<void>>();
const mockDeleteBranch = vi.fn<(branch: string, opts?: unknown) => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({ checkout: mockCheckout, push: mockPush, deleteBranch: mockDeleteBranch })),
  GitError: class GitError extends Error {},
}));

const mockPrCreate = vi.fn<() => Promise<string>>();
const mockPrView = vi.fn<() => Promise<{ state: string; url: string } | null>>();
vi.mock('./gh.js', () => ({ gh: vi.fn(() => ({ prCreate: mockPrCreate, prView: mockPrView })) }));

const mockAddNote = vi.fn<() => Promise<string>>();
const mockAddLabel = vi.fn<() => Promise<string>>();
const mockRemoveLabel = vi.fn<() => Promise<string>>();
const mockClose = vi.fn<() => Promise<string>>();
const mockFlag = vi.fn<() => Promise<string>>();
const mockList = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({
    addNote: mockAddNote,
    addLabel: mockAddLabel,
    removeLabel: mockRemoveLabel,
    close: mockClose,
    flag: mockFlag,
    list: mockList,
  })),
  syncBeads: mockSyncBeads,
}));

const mockClearBeadAttempts = vi.fn();
vi.mock('../kshetra/state.js', () => ({
  clearBeadAttempts: mockClearBeadAttempts,
  pauseKshetra: vi.fn(),
}));

vi.mock('./parikshaka-dispatch.js', () => ({ dispatchParikshakaAsync: vi.fn() }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { resolveMergePolicy, openPrAndDefer, reconcilePullRequests, parseAwaitingMerge, AWAITING_MERGE_LABEL } =
  await import('./merge.js');

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
  beads: { path: '/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = { id: 'proj-42', slug: 'fix-auth', title: 'Fix auth', status: 'in_progress', priority: 2 };

const OUTPUT: SilpiOutput = {
  filesChanged: [{ path: 'src/auth.ts', diff: '- old\n+ new' }],
  testFiles: [],
  summary: 'fixed auth',
  confidenceScore: 90,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SHRENI_MERGE_POLICY;
});

afterEach(() => {
  delete process.env.SHRENI_MERGE_POLICY;
});

describe('resolveMergePolicy', () => {
  it('defaults to push when neither env nor config is set', () => {
    expect(resolveMergePolicy(KSHETRA)).toBe('push');
  });

  it('honours repo.mergePolicy from config', () => {
    expect(resolveMergePolicy({ ...KSHETRA, repo: { ...KSHETRA.repo, mergePolicy: 'pr' } })).toBe('pr');
  });

  it('SHRENI_MERGE_POLICY overrides config', () => {
    process.env.SHRENI_MERGE_POLICY = 'pr';
    expect(resolveMergePolicy(KSHETRA)).toBe('pr');
    process.env.SHRENI_MERGE_POLICY = 'push';
    expect(resolveMergePolicy({ ...KSHETRA, repo: { ...KSHETRA.repo, mergePolicy: 'pr' } })).toBe('push');
  });

  it('ignores a garbage env value and falls back to config/default', () => {
    process.env.SHRENI_MERGE_POLICY = 'nonsense';
    expect(resolveMergePolicy(KSHETRA)).toBe('push');
  });
});

describe('openPrAndDefer', () => {
  beforeEach(() => {
    mockPrCreate.mockResolvedValue('https://github.com/TeakWood/myapp/pull/1');
  });

  it('pushes the bead branch and opens a PR against main', async () => {
    await openPrAndDefer(TASK, KSHETRA, OUTPUT);
    expect(mockPush).toHaveBeenCalledWith('origin', 'bead-proj-42/fix-auth');
    const prArgs = mockPrCreate.mock.calls[0]![0] as { base: string; head: string; title: string };
    expect(prArgs.base).toBe('main');
    expect(prArgs.head).toBe('bead-proj-42/fix-auth');
    expect(prArgs.title).toContain('proj-42');
  });

  it('labels the bead awaiting-merge and does NOT close it or delete the branch', async () => {
    await openPrAndDefer(TASK, KSHETRA, OUTPUT);
    expect(mockAddLabel).toHaveBeenCalledWith('proj-42', AWAITING_MERGE_LABEL);
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('records the PR url as a bead note and syncs', async () => {
    await openPrAndDefer(TASK, KSHETRA, OUTPUT);
    expect(mockAddNote).toHaveBeenCalledWith('proj-42', expect.stringContaining('pull/1'));
    expect(mockSyncBeads).toHaveBeenCalled();
  });
});

describe('parseAwaitingMerge', () => {
  it('reconstructs the branch slug deterministically from the title', () => {
    const beads = parseAwaitingMerge(JSON.stringify([{ id: 'proj-42', title: 'Fix Auth Bug!' }]));
    expect(beads).toEqual([{ id: 'proj-42', title: 'Fix Auth Bug!', slug: 'fix-auth-bug' }]);
  });

  it('tolerates malformed JSON and non-arrays', () => {
    expect(parseAwaitingMerge('not json')).toEqual([]);
    expect(parseAwaitingMerge('{}')).toEqual([]);
  });
});

describe('reconcilePullRequests', () => {
  it('does nothing when there are no awaiting-merge beads', async () => {
    mockList.mockResolvedValue('[]');
    await reconcilePullRequests(KSHETRA);
    expect(mockPrView).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('queries in_progress beads filtered to the awaiting-merge label', async () => {
    mockList.mockResolvedValue('[]');
    await reconcilePullRequests(KSHETRA);
    expect(mockList).toHaveBeenCalledWith({ status: 'in_progress', label: AWAITING_MERGE_LABEL });
  });

  it('closes the bead and drops the branch when the PR merged', async () => {
    mockList.mockResolvedValue(JSON.stringify([{ id: 'proj-42', title: 'Fix auth' }]));
    mockPrView.mockResolvedValue({ state: 'MERGED', url: 'https://x/pull/1' });
    await reconcilePullRequests(KSHETRA);
    expect(mockClose).toHaveBeenCalledWith('proj-42', expect.stringContaining('Merged via PR'));
    expect(mockClearBeadAttempts).toHaveBeenCalledWith(KSHETRA, 'proj-42');
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-proj-42/fix-auth', { force: true });
    expect(mockPush).toHaveBeenCalledWith('origin', '--delete', 'bead-proj-42/fix-auth');
  });

  it('blocks the bead and clears the label when the PR was closed unmerged', async () => {
    mockList.mockResolvedValue(JSON.stringify([{ id: 'proj-42', title: 'Fix auth' }]));
    mockPrView.mockResolvedValue({ state: 'CLOSED', url: 'https://x/pull/1' });
    await reconcilePullRequests(KSHETRA);
    expect(mockRemoveLabel).toHaveBeenCalledWith('proj-42', AWAITING_MERGE_LABEL);
    expect(mockFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining('closed without merging'));
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('leaves the bead untouched while the PR is still open', async () => {
    mockList.mockResolvedValue(JSON.stringify([{ id: 'proj-42', title: 'Fix auth' }]));
    mockPrView.mockResolvedValue({ state: 'OPEN', url: 'https://x/pull/1' });
    await reconcilePullRequests(KSHETRA);
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('survives a merged-branch delete that already happened (auto-delete)', async () => {
    mockList.mockResolvedValue(JSON.stringify([{ id: 'proj-42', title: 'Fix auth' }]));
    mockPrView.mockResolvedValue({ state: 'MERGED', url: 'https://x/pull/1' });
    mockDeleteBranch.mockRejectedValueOnce(new Error('branch not found'));
    mockPush.mockRejectedValueOnce(new Error('remote ref does not exist'));
    await expect(reconcilePullRequests(KSHETRA)).resolves.toBeUndefined();
    expect(mockClose).toHaveBeenCalled();
  });
});