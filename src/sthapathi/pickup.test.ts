import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockStatus = vi.fn<() => Promise<{ modified: string[]; staged: string[]; untracked: string[] }>>();
const mockBranchExists = vi.fn<() => Promise<boolean>>();
const mockRemoteBranchExists = vi.fn<() => Promise<boolean>>();
const mockCheckout = vi.fn<() => Promise<void>>();
const mockPull = vi.fn<() => Promise<void>>();
const mockFetch = vi.fn<() => Promise<void>>();
const mockResetHard = vi.fn<() => Promise<void>>();
const mockDiscardPath = vi.fn<(p: string) => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    status: mockStatus,
    branchExists: mockBranchExists,
    remoteBranchExists: mockRemoteBranchExists,
    checkout: mockCheckout,
    pull: mockPull,
    fetch: mockFetch,
    resetHard: mockResetHard,
    discardPath: mockDiscardPath,
  })),
  GitError: class GitError extends Error { constructor(public readonly code: string, message: string) { super(message); } },
}));

const mockCheckHealth = vi.fn<() => Promise<{ green: boolean; failCount: number; baseline: number; sha: string }>>();
const mockEnsureHealthBead = vi.fn<() => Promise<boolean>>();
const mockIsHealthBead = vi.fn<(t: Task) => boolean>();

vi.mock('./health.js', () => ({
  checkHealth: () => mockCheckHealth(),
  ensureHealthBead: () => mockEnsureHealthBead(),
  isHealthBead: (t: Task) => mockIsHealthBead(t),
}));

// Capture emitted events (epic 8wi: the pickup-health suppression record).
const { emitSpy } = vi.hoisted(() => ({ emitSpy: vi.fn() }));
vi.mock('./activity-log.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, emit: emitSpy };
});

// ── imports after mocks ──────────────────────────────────────────────────────

const { parseReadyOutput, rankCandidates, preFlightCheck, preFlightFresh, PreFlightError, BaseRedError, MISSING_BASE_BRANCH_REASON } =
  await import('./pickup.js');
// What pickup would take first: the best-ranked candidate.
const pickNext = (tasks: Task[]): Task | null => rankCandidates(tasks)[0] ?? null;
// state + notifications are real, but src/test-setup.ts redirects HOME to a
// throwaway temp dir, so these read/write a per-run sandbox — never ~/.shreni.
const { loadState } = await import('../kshetra/state.js');
const { readNotifications } = await import('./notifications.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

function makeIssue(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'proj-123',
    title: 'Fix login bug',
    priority: 2,
    status: 'open',
    description: 'Details here',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue({ modified: [], staged: [], untracked: [] });
  mockDiscardPath.mockResolvedValue(undefined);
  mockBranchExists.mockResolvedValue(false);
  mockRemoteBranchExists.mockResolvedValue(true); // base branch present by default
  mockCheckout.mockResolvedValue(undefined);
  mockPull.mockResolvedValue(undefined);
  mockCheckHealth.mockResolvedValue({ green: true, failCount: 0, baseline: 0, sha: 'sha' });
  mockEnsureHealthBead.mockResolvedValue(true);
  mockIsHealthBead.mockReturnValue(false);
});

// ── parseReadyOutput ──────────────────────────────────────────────────────────

describe('parseReadyOutput', () => {
  it('returns empty array for empty JSON array', () => {
    expect(parseReadyOutput('[]')).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseReadyOutput('not-json')).toEqual([]);
  });

  it('returns empty array when JSON is not an array', () => {
    expect(parseReadyOutput('{"id":"x"}')).toEqual([]);
  });

  it('parses a valid issue into a Task', () => {
    const raw = JSON.stringify([makeIssue()]);
    const tasks = parseReadyOutput(raw);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('proj-123');
    expect(tasks[0].title).toBe('Fix login bug');
    expect(tasks[0].priority).toBe(2);
    expect(tasks[0].status).toBe('pending');
  });

  it('derives slug from title (lowercase, hyphens, no special chars)', () => {
    const raw = JSON.stringify([makeIssue({ title: 'bd ready → pickNext → bd claim' })]);
    const [task] = parseReadyOutput(raw);
    expect(task.slug).toBe('bd-ready-picknext-bd-claim');
  });

  it('trims leading and trailing hyphens from slug', () => {
    const raw = JSON.stringify([makeIssue({ title: '  Fix login  ' })]);
    const [task] = parseReadyOutput(raw);
    expect(task.slug).not.toMatch(/^-|-$/);
  });

  it('caps slug at 50 characters', () => {
    const raw = JSON.stringify([makeIssue({ title: 'a'.repeat(100) })]);
    const [task] = parseReadyOutput(raw);
    expect(task.slug.length).toBeLessThanOrEqual(50);
  });

  it('skips items missing required fields', () => {
    const raw = JSON.stringify([
      makeIssue(),
      { id: 'x', priority: 1 }, // missing title
      makeIssue({ id: 'proj-456' }),
    ]);
    const tasks = parseReadyOutput(raw);
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.id)).toEqual(['proj-123', 'proj-456']);
  });

  it('maps beads status "open" to Task status "pending"', () => {
    const raw = JSON.stringify([makeIssue({ status: 'open' })]);
    const [task] = parseReadyOutput(raw);
    expect(task.status).toBe('pending');
  });

  it('carries description and notes through', () => {
    const raw = JSON.stringify([makeIssue({ notes: 'round 1 insight' })]);
    const [task] = parseReadyOutput(raw);
    expect(task.description).toBe('Details here');
    expect(task.notes).toBe('round 1 insight');
  });
});

// ── pickNext ──────────────────────────────────────────────────────────────────

describe('pickNext', () => {
  it('returns null for empty array', () => {
    expect(pickNext([])).toBeNull();
  });

  it('returns the only task when there is one', () => {
    const task: Task = { id: 'x', slug: 'x', title: 'X', status: 'pending', priority: 2 };
    expect(pickNext([task])).toBe(task);
  });

  it('picks P0 over higher-number priority', () => {
    const p2: Task = { id: 'a', slug: 'a', title: 'A', status: 'pending', priority: 2 };
    const p0: Task = { id: 'b', slug: 'b', title: 'B', status: 'pending', priority: 0 };
    const p1: Task = { id: 'c', slug: 'c', title: 'C', status: 'pending', priority: 1 };
    expect(pickNext([p2, p0, p1])!.id).toBe('b');
  });

  it('preserves FIFO order for tasks with equal priority', () => {
    const first: Task = { id: 'first', slug: 'first', title: 'First', status: 'pending', priority: 1 };
    const second: Task = { id: 'second', slug: 'second', title: 'Second', status: 'pending', priority: 1 };
    expect(pickNext([first, second])!.id).toBe('first');
  });

  it('does not mutate the input array', () => {
    const tasks: Task[] = [
      { id: 'a', slug: 'a', title: 'A', status: 'pending', priority: 2 },
      { id: 'b', slug: 'b', title: 'B', status: 'pending', priority: 0 },
    ];
    const original = [...tasks];
    pickNext(tasks);
    expect(tasks).toEqual(original);
  });

  // ── queue isolation (ARD §9.1): the load-bearing filter test ──────────────
  // A suthradhara-session bead must NEVER be returned as executable work, even
  // when it is the only ready bead and would otherwise win on priority.

  it('never returns a suthradhara-session bead, even a lone ready P0 one', () => {
    const session: Task = { id: 's', slug: 's', title: 'Suthradhara session', status: 'pending', priority: 0, type: 'suthradhara-session' };
    expect(pickNext([session])).toBeNull();
  });

  it('skips a session bead and picks the next-highest real task', () => {
    const session: Task = { id: 's', slug: 's', title: 'session', status: 'pending', priority: 0, type: 'suthradhara-session' };
    const real: Task = { id: 'r', slug: 'r', title: 'Real work', status: 'pending', priority: 2, type: 'task' };
    expect(pickNext([session, real])!.id).toBe('r');
  });

  // -- epics are never work (Shreni-beads-q08): the authoritative filter --
  it('never returns an epic, even a lone ready P0 one', () => {
    const epic: Task = { id: 'e', slug: 'e', title: 'Rollout epic', status: 'pending', priority: 0, type: 'epic' };
    expect(pickNext([epic])).toBeNull();
  });

  it('skips an epic and picks the next-highest real task', () => {
    const epic: Task = { id: 'e', slug: 'e', title: 'epic', status: 'pending', priority: 0, type: 'epic' };
    const real: Task = { id: 'r', slug: 'r', title: 'Real work', status: 'pending', priority: 3, type: 'task' };
    expect(pickNext([epic, real])!.id).toBe('r');
  });

  it('excludes session beads whatever their status (type is the guarantee, not status)', () => {
    const open: Task = { id: 'o', slug: 'o', title: 'open session', status: 'pending', priority: 1, type: 'suthradhara-session' };
    const claimed: Task = { id: 'c', slug: 'c', title: 'in-progress session', status: 'in_progress', priority: 1, type: 'suthradhara-session' };
    expect(pickNext([open, claimed])).toBeNull();
  });
});

// ── parseReadyOutput carries issue_type through as Task.type ────────────────

describe('parseReadyOutput issue_type', () => {
  it('maps bd issue_type onto Task.type so the filter can see it', () => {
    const raw = JSON.stringify([makeIssue({ id: 's', issue_type: 'suthradhara-session' })]);
    const [task] = parseReadyOutput(raw);
    expect(task.type).toBe('suthradhara-session');
    // End-to-end: a ready payload containing only a session bead selects nothing.
    expect(pickNext(parseReadyOutput(raw))).toBeNull();
  });

  it('leaves type undefined when the source omits issue_type', () => {
    const [task] = parseReadyOutput(JSON.stringify([makeIssue()]));
    expect(task.type).toBeUndefined();
  });
});

// ── preFlightCheck ────────────────────────────────────────────────────────────

describe('preFlightCheck', () => {
  const TASK: Task = { id: 'proj-123', slug: 'fix-login-bug', title: 'Fix login bug', status: 'pending', priority: 2 };

  it('resolves when tree is clean and branch does not exist', async () => {
    await expect(preFlightCheck(TASK, KSHETRA)).resolves.not.toThrow();
  });

  it('throws PreFlightError when there are modified files', async () => {
    mockStatus.mockResolvedValue({ modified: ['src/app.ts'], staged: [], untracked: [] });
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow(PreFlightError);
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow('dirty working tree');
  });

  it('throws PreFlightError when there are staged files', async () => {
    mockStatus.mockResolvedValue({ modified: [], staged: ['src/staged.ts'], untracked: [] });
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow(PreFlightError);
  });

  it('throws PreFlightError when the task branch already exists', async () => {
    mockBranchExists.mockResolvedValue(true);
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow(PreFlightError);
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow('branch already exists');
  });

  it('names the expected branch in the error message', async () => {
    mockBranchExists.mockResolvedValue(true);
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow('bead-proj-123/fix-login-bug');
  });

  it('carries the task on the thrown PreFlightError', async () => {
    mockBranchExists.mockResolvedValue(true);
    const err = await preFlightCheck(TASK, KSHETRA).catch(e => e);
    expect(err).toBeInstanceOf(PreFlightError);
    expect((err as { task: Task }).task).toBe(TASK);
  });

  it('untracked files do not block preflight', async () => {
    mockStatus.mockResolvedValue({ modified: [], staged: [], untracked: ['new-file.ts'] });
    await expect(preFlightCheck(TASK, KSHETRA)).resolves.not.toThrow();
  });

  it('discards the regenerated repo-map before the cleanliness gate', async () => {
    await preFlightCheck(TASK, KSHETRA);
    expect(mockDiscardPath).toHaveBeenCalledWith('.shreni/repo-map.md');
  });

  it('does not wedge when the ONLY dirty path is the regenerated repo-map', async () => {
    // The wedge scenario: squashMergeAndClose regenerated .shreni/repo-map.md
    // fire-and-forget, leaving it modified in a repo that tracks it. discardPath
    // reverts it, so by the time status is read the tree is clean again.
    mockDiscardPath.mockImplementation(async () => {
      mockStatus.mockResolvedValue({ modified: [], staged: [], untracked: [] });
    });
    mockStatus.mockResolvedValue({ modified: ['.shreni/repo-map.md'], staged: [], untracked: [] });
    await expect(preFlightCheck(TASK, KSHETRA)).resolves.not.toThrow();
    expect(mockDiscardPath).toHaveBeenCalledWith('.shreni/repo-map.md');
  });

  it('still wedges on real drift alongside the repo-map', async () => {
    // discardPath only touches the map; a genuine source edit must still trip
    // the gate so real drift is never silently swallowed.
    mockDiscardPath.mockImplementation(async () => {
      mockStatus.mockResolvedValue({ modified: ['src/app.ts'], staged: [], untracked: [] });
    });
    mockStatus.mockResolvedValue({ modified: ['.shreni/repo-map.md', 'src/app.ts'], staged: [], untracked: [] });
    await expect(preFlightCheck(TASK, KSHETRA)).rejects.toThrow('dirty working tree');
  });

  // ── missing base branch guard (uvu.4) ──────────────────────────────────────
  // Each test uses a UNIQUE kshetra id so the persisted pause + notification
  // feed (real state.json / notifications.jsonl in the temp HOME) never bleed
  // across tests.
  describe('missing base branch', () => {
    function ksh(id: string): KshetraConfig {
      return { ...KSHETRA, id, repo: { ...KSHETRA.repo, mainBranch: 'develop' } };
    }

    it('checks the base branch BEFORE checking out main', async () => {
      const order: string[] = [];
      mockRemoteBranchExists.mockImplementation(async () => { order.push('remote-check'); return true; });
      mockCheckout.mockImplementation(async () => { order.push('checkout'); });
      await preFlightCheck(TASK, ksh('base-order'));
      expect(order.indexOf('remote-check')).toBeLessThan(order.indexOf('checkout'));
    });

    it('does not touch the work tree when the base branch is present', async () => {
      await preFlightCheck(TASK, ksh('base-present'));
      expect(mockCheckout).toHaveBeenCalled(); // normal path proceeds
    });

    it('pauses + notifies + aborts before checkout when the base is missing', async () => {
      const k = ksh('base-missing');
      mockRemoteBranchExists.mockResolvedValue(false);
      await expect(preFlightCheck(TASK, k)).rejects.toThrow(PreFlightError);
      expect(mockCheckout).not.toHaveBeenCalled(); // aborted before the cryptic failure point

      const s = loadState().kshetras[k.id];
      expect(s?.paused).toBe(true);
      expect(s?.reason).toBe(MISSING_BASE_BRANCH_REASON);
      expect(s?.requiresManualResume).toBe(true);

      const notes = readNotifications(k.id);
      expect(notes).toHaveLength(1);
      expect(notes[0].event).toBe(MISSING_BASE_BRANCH_REASON);
      expect(notes[0].message).toContain('develop');
      expect(notes[0].remediation).toContain(k.id);
    });

    it('is idempotent: a second poll neither re-pauses nor re-notifies', async () => {
      const k = ksh('base-idempotent');
      mockRemoteBranchExists.mockResolvedValue(false);
      await expect(preFlightCheck(TASK, k)).rejects.toThrow(PreFlightError);
      await expect(preFlightCheck(TASK, k)).rejects.toThrow(PreFlightError);
      await expect(preFlightCheck(TASK, k)).rejects.toThrow(PreFlightError);
      // three polls, ONE notification (not one per poll)
      expect(readNotifications(k.id)).toHaveLength(1);
    });

    it('preFlightFresh refuses (the claim is given back) before the health gate when the base branch is missing', async () => {
      const k = ksh('base-prepare');
      mockRemoteBranchExists.mockResolvedValue(false);
      await expect(preFlightFresh(TASK, k)).rejects.toThrow(PreFlightError);
      expect(mockCheckHealth).not.toHaveBeenCalled();
    });
  });
});

// ── pickup ────────────────────────────────────────────────────────────────────

describe('preFlightFresh (the engine\'s preflight for a fresh task)', () => {
  const TASK: Task = { id: 'proj-123', slug: 'fix-login-bug', title: 'Fix login bug', status: 'pending', priority: 2 };

  it('passes when the work tree is clean and the base suite is green', async () => {
    await expect(preFlightFresh(TASK, KSHETRA)).resolves.toBeUndefined();
    expect(mockEnsureHealthBead).not.toHaveBeenCalled();
  });

  it('refuses with PreFlightError, before the health gate, when the tree is dirty', async () => {
    mockStatus.mockResolvedValue({ modified: ['src/dirty.ts'], staged: [], untracked: [] });
    await expect(preFlightFresh(TASK, KSHETRA)).rejects.toThrow(PreFlightError);
    expect(mockCheckHealth).not.toHaveBeenCalled();
  });

  it('refuses when the task branch is left over', async () => {
    mockBranchExists.mockResolvedValue(true);
    await expect(preFlightFresh(TASK, KSHETRA)).rejects.toThrow('branch already exists');
  });

  it('rethrows a non-PreFlightError from git as it is', async () => {
    mockStatus.mockRejectedValue(new Error('git crash'));
    await expect(preFlightFresh(TASK, KSHETRA)).rejects.toThrow('git crash');
  });

  it('refuses with BaseRedError and queues one health repair when the base suite is red', async () => {
    mockCheckHealth.mockResolvedValue({ green: false, failCount: 3, baseline: 0, sha: 'sha' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(preFlightFresh(TASK, KSHETRA)).rejects.toThrow(BaseRedError);
    expect(mockEnsureHealthBead).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('under enforcement ablation, passes on a red suite without a health task, recording the suppression (epic 8wi)', async () => {
    emitSpy.mockClear();
    mockCheckHealth.mockResolvedValue({ green: false, failCount: 3, baseline: 0, sha: 'sha' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ablated = { ...KSHETRA, ablation: { enforcement: 'off' } } as unknown as KshetraConfig;
    await expect(preFlightFresh(TASK, ablated)).resolves.toBeUndefined();
    expect(mockEnsureHealthBead).not.toHaveBeenCalled();
    const suppression = emitSpy.mock.calls
      .map((c: unknown[]) => c[0] as { type: string; gate?: string; verdict?: string; ablations?: string[] })
      .find(e => e.type === 'gate_result' && e.gate === 'pickup-health');
    expect(suppression).toMatchObject({ verdict: 'warn', ablations: ['enforcement'] });
    warn.mockRestore();
  });

  it('a health task bypasses the gate even when the suite is red', async () => {
    mockIsHealthBead.mockReturnValue(true);
    mockCheckHealth.mockResolvedValue({ green: false, failCount: 3, baseline: 0, sha: 'sha' });
    await expect(preFlightFresh(TASK, KSHETRA)).resolves.toBeUndefined();
    expect(mockCheckHealth).not.toHaveBeenCalled();
  });
});
