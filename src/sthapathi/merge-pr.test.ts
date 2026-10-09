import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';

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
const mockPrStatus = vi.fn<() => Promise<unknown>>();
vi.mock('./gh.js', () => ({ gh: vi.fn(() => ({ prCreate: mockPrCreate, prView: mockPrView, prStatus: mockPrStatus })) }));

// The task store (the engine): openPrAndDefer records the PR; reconcile walks
// the tasks waiting on their PRs.
const mockDeferForPr = vi.fn<(id: string, url: string) => Promise<void>>();
const mockFlag = vi.fn<(id: string, reason: string) => Promise<void>>();
const mockListAwaitingMerge = vi.fn<() => Promise<{ id: string; title: string; slug: string }[]>>();
const mockFinish = vi.fn<(id: string, reason: string) => Promise<void>>();
const mockPrDeclined = vi.fn<(id: string, reason: string) => Promise<void>>();
const mockNeedsFollowup = vi.fn<(id: string) => Promise<void>>();
const mockReadWatermark = vi.fn<(id: string) => Promise<{ head: string | null; round: number; at: string | null }>>();
vi.mock('./task-store.js', () => ({
  engineStore: vi.fn(() => ({
    deferForPr: mockDeferForPr,
    flag: mockFlag,
    listAwaitingMerge: mockListAwaitingMerge,
    finish: mockFinish,
    prDeclined: mockPrDeclined,
    needsFollowup: mockNeedsFollowup,
    readWatermark: mockReadWatermark,
  })),
  trackerFor: vi.fn(() => ({ addNote: vi.fn(async () => ''), flag: vi.fn(async () => '') })),
}));

const mockClearBeadAttempts = vi.fn();
vi.mock('../kshetra/state.js', () => ({
  clearBeadAttempts: mockClearBeadAttempts,
  pauseKshetra: vi.fn(),
}));

vi.mock('./parikshaka-dispatch.js', () => ({ dispatchParikshakaAsync: vi.fn() }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { resolveMergePolicy, openPrAndDefer, buildPrBody, reconcilePullRequests } = await import('./merge.js');

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

const FEEDBACK: ViharapalaOutput = {
  verdict: 'APPROVE',
  overallScore: 92,
  mustFix: [],
  suggestions: [],
  issues: [],
  insights: [],
};

// Realistic `bd show <id> --json` payload: a JSON array whose first element is
// the bead and whose remaining elements are its dependencies, each carrying its
// own description / acceptance_criteria / close_reason etc. buildPrBody must
// surface ONLY proj-42's acceptance_criteria and leak none of the rest (bqn).
const TASK_DETAILS = JSON.stringify([
  {
    id: 'proj-42',
    title: 'Fix auth',
    description: 'Auth lets bad passwords through; harden the login check.',
    acceptance_criteria: 'Login rejects a bad password.',
    status: 'in_progress',
    priority: 2,
    close_reason: '',
    parent: 'proj-40',
  },
  {
    id: 'proj-40',
    title: 'Auth epic',
    description: 'Umbrella epic for auth hardening — SHOULD NOT appear in the PR body.',
    acceptance_criteria: 'All auth beads closed — SHOULD NOT appear in the PR body.',
    status: 'open',
    priority: 1,
    dependency_type: 'parent-child',
  },
], null, 2);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SHRENI_MERGE_POLICY;
  mockListAwaitingMerge.mockResolvedValue([]);
  mockReadWatermark.mockResolvedValue({ head: null, round: 0, at: null });
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
    await openPrAndDefer(TASK, KSHETRA, OUTPUT, FEEDBACK, TASK_DETAILS);
    expect(mockPush).toHaveBeenCalledWith('origin', 'bead-proj-42/fix-auth');
    const prArgs = mockPrCreate.mock.calls[0]![0] as { base: string; head: string; title: string };
    expect(prArgs.base).toBe('main');
    expect(prArgs.head).toBe('bead-proj-42/fix-auth');
    expect(prArgs.title).toContain('proj-42');
  });

  it('renders the acceptance criteria + reviewer verdict into the PR body', async () => {
    await openPrAndDefer(TASK, KSHETRA, OUTPUT, FEEDBACK, TASK_DETAILS);
    const prArgs = mockPrCreate.mock.calls[0]![0] as { body: string };
    expect(prArgs.body).toContain('## Acceptance criteria');
    expect(prArgs.body).toContain('Login rejects a bad password.');
    expect(prArgs.body).toContain('## Reviewer verdict');
    expect(prArgs.body).toContain('Verdict: **APPROVE**');
    expect(prArgs.body).toContain('Score: 92/100');
    // Only the criteria surface — the raw --json blob (descriptions, the parent
    // dependency, close_reason) must not leak into the body (bqn).
    expect(prArgs.body).not.toContain('SHOULD NOT appear');
    expect(prArgs.body).not.toContain('"acceptance_criteria"');
    expect(prArgs.body).not.toContain('harden the login check');
  });

  it('records the PR on the task (deferForPr) and does NOT finish it or delete the branch', async () => {
    await openPrAndDefer(TASK, KSHETRA, OUTPUT, FEEDBACK, TASK_DETAILS);
    expect(mockDeferForPr).toHaveBeenCalledWith('proj-42', 'https://github.com/TeakWood/myapp/pull/1');
    expect(mockFinish).not.toHaveBeenCalled();
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('flags the task with the PR when recording it fails, rather than throwing', async () => {
    mockDeferForPr.mockRejectedValue(new Error('db down'));
    await expect(openPrAndDefer(TASK, KSHETRA, OUTPUT, FEEDBACK, TASK_DETAILS)).resolves.toBeUndefined();
    expect(mockFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining('pull/1'));
  });
});

describe('buildPrBody', () => {
  it('keeps the commit-message summary as the header, then appends both blocks', () => {
    const body = buildPrBody(TASK, OUTPUT, FEEDBACK, TASK_DETAILS);
    // Header comes from buildCommitMessage (title + id, summary, confidence).
    expect(body.startsWith('Fix auth (proj-42)')).toBe(true);
    expect(body).toContain('Confidence: 90%');
    // Order: acceptance criteria block precedes the reviewer verdict block.
    expect(body.indexOf('## Acceptance criteria')).toBeLessThan(body.indexOf('## Reviewer verdict'));
  });

  it('renders only the bead\'s acceptance_criteria, not the raw --json payload', () => {
    const body = buildPrBody(TASK, OUTPUT, FEEDBACK, TASK_DETAILS);
    expect(body).toContain('Login rejects a bad password.');
    // No JSON structure and nothing from the parent dependency leaks through.
    expect(body).not.toContain('SHOULD NOT appear');
    expect(body).not.toContain('"id":');
    expect(body).not.toContain('[');
  });

  it('lists must-fix items when the reviewer flagged any', () => {
    const body = buildPrBody(TASK, OUTPUT, { ...FEEDBACK, verdict: 'REJECT', mustFix: ['handle null user', 'add a test'] }, TASK_DETAILS);
    expect(body).toContain('- Must-fix:');
    expect(body).toContain('  - handle null user');
    expect(body).toContain('  - add a test');
  });

  it('says "none" when there are no must-fix items', () => {
    expect(buildPrBody(TASK, OUTPUT, FEEDBACK, TASK_DETAILS)).toContain('- Must-fix: none');
  });

  it('degrades gracefully when the payload is unparseable', () => {
    expect(buildPrBody(TASK, OUTPUT, FEEDBACK, '   ')).toContain('_(no acceptance criteria recorded)_');
  });

  it('degrades gracefully when the bead records no acceptance criteria', () => {
    const noCriteria = JSON.stringify([{ id: 'proj-42', title: 'Fix auth' }]);
    expect(buildPrBody(TASK, OUTPUT, FEEDBACK, noCriteria)).toContain('_(no acceptance criteria recorded)_');
  });
});

const WAITING = [{ id: 'proj-42', title: 'Fix auth', slug: 'fix-auth' }];

describe('reconcilePullRequests', () => {
  it('does nothing when no task waits on a PR', async () => {
    await reconcilePullRequests(KSHETRA);
    expect(mockPrView).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('finishes the task and drops the branch when the PR merged', async () => {
    mockListAwaitingMerge.mockResolvedValue(WAITING);
    mockPrView.mockResolvedValue({ state: 'MERGED', url: 'https://x/pull/1' });
    await reconcilePullRequests(KSHETRA);
    expect(mockFinish).toHaveBeenCalledWith('proj-42', expect.stringContaining('Merged via PR'));
    expect(mockClearBeadAttempts).toHaveBeenCalledWith(KSHETRA, 'proj-42');
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-proj-42/fix-auth', { force: true });
    expect(mockPush).toHaveBeenCalledWith('origin', '--delete', 'bead-proj-42/fix-auth');
  });

  it('flags the task when finish is refused after the PR merged', async () => {
    mockListAwaitingMerge.mockResolvedValue(WAITING);
    mockPrView.mockResolvedValue({ state: 'MERGED', url: 'https://x/pull/1' });
    mockFinish.mockRejectedValue(new Error('a manual check waits'));
    await expect(reconcilePullRequests(KSHETRA)).resolves.toBeUndefined();
    expect(mockFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining('finish failed: a manual check waits'));
  });

  it('declines the task when the PR was closed unmerged', async () => {
    mockListAwaitingMerge.mockResolvedValue(WAITING);
    mockPrView.mockResolvedValue({ state: 'CLOSED', url: 'https://x/pull/1' });
    await reconcilePullRequests(KSHETRA);
    expect(mockPrDeclined).toHaveBeenCalledWith('proj-42', expect.stringContaining('closed without merging'));
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('leaves the task untouched while the PR is still open', async () => {
    mockListAwaitingMerge.mockResolvedValue(WAITING);
    mockPrView.mockResolvedValue({ state: 'OPEN', url: 'https://x/pull/1' });
    await reconcilePullRequests(KSHETRA);
    expect(mockFinish).not.toHaveBeenCalled();
    expect(mockPrDeclined).not.toHaveBeenCalled();
    expect(mockDeleteBranch).not.toHaveBeenCalled();
  });

  it('survives a merged-branch delete that already happened (auto-delete)', async () => {
    mockListAwaitingMerge.mockResolvedValue(WAITING);
    mockPrView.mockResolvedValue({ state: 'MERGED', url: 'https://x/pull/1' });
    mockDeleteBranch.mockRejectedValueOnce(new Error('branch not found'));
    mockPush.mockRejectedValueOnce(new Error('remote ref does not exist'));
    await expect(reconcilePullRequests(KSHETRA)).resolves.toBeUndefined();
    expect(mockFinish).toHaveBeenCalled();
  });

  it('one task\'s failure does not hold up the rest of the pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListAwaitingMerge.mockResolvedValue([
      { id: 'proj-42', title: 'Epic auth', slug: 'epic-auth' },
      { id: 'proj-99', title: 'Fix login', slug: 'fix-login' },
    ]);
    mockPrView.mockResolvedValue({ state: 'MERGED', url: 'https://x/pull/1' });
    mockFinish.mockRejectedValueOnce(new Error('refused'));
    mockFlag.mockRejectedValueOnce(new Error('database is locked'));
    await expect(reconcilePullRequests(KSHETRA)).resolves.toBeUndefined();
    expect(mockFinish).toHaveBeenCalledWith('proj-99', expect.stringContaining('Merged via PR'));
    expect(mockClearBeadAttempts).toHaveBeenCalledWith(KSHETRA, 'proj-99');
  });

  // Active follow-up detection (epic hjw): OPEN is no longer an unconditional
  // no-op when the policy is on.
  describe('OPEN-PR follow-up detection', () => {
    const KSHETRA_FU = {
      ...KSHETRA,
      repo: { ...KSHETRA.repo, prFollowup: true, prFollowupSelfLogins: [], prFollowupRequiredChecks: [] },
    } as unknown as KshetraConfig;

    const openWithReview = {
      state: 'OPEN',
      url: 'https://x/pull/1',
      reviews: [{ author: 'human', state: 'CHANGES_REQUESTED', body: 'fix', submittedAt: '2026-07-29T12:00:00Z', comments: [] }],
      checks: [],
      commits: [],
    };

    beforeEach(() => {
      mockListAwaitingMerge.mockResolvedValue(WAITING);
      mockPrView.mockResolvedValue({ state: 'OPEN', url: 'https://x/pull/1' });
    });

    it('reopens the task for a follow-up on an OPEN PR with unaddressed feedback', async () => {
      mockPrStatus.mockResolvedValue(openWithReview);
      await reconcilePullRequests(KSHETRA_FU);
      expect(mockNeedsFollowup).toHaveBeenCalledWith('proj-42');
    });

    it('does NOT reopen when the policy is off (default)', async () => {
      await reconcilePullRequests(KSHETRA); // KSHETRA has no prFollowup → off
      expect(mockPrStatus).not.toHaveBeenCalled();
      expect(mockNeedsFollowup).not.toHaveBeenCalled();
    });

    it('does NOT reopen on a foreign commit when prFollowupSelfLogins is empty (default)', async () => {
      mockPrStatus.mockResolvedValue({
        state: 'OPEN', url: 'https://x/pull/1', reviews: [], checks: [],
        commits: [{ sha: 'ccc', author: 'collaborator' }],
      });
      await reconcilePullRequests(KSHETRA_FU); // selfLogins: []
      expect(mockNeedsFollowup).not.toHaveBeenCalled();
    });

    it('does NOT reopen when the feedback is already addressed (watermark newer)', async () => {
      mockPrStatus.mockResolvedValue(openWithReview);
      mockReadWatermark.mockResolvedValue({ head: 'h', round: 1, at: '2026-07-29T23:00:00Z' });
      await reconcilePullRequests(KSHETRA_FU);
      expect(mockNeedsFollowup).not.toHaveBeenCalled();
    });
  });
});
