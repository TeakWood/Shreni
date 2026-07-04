import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockReady = vi.fn<() => Promise<string>>();
const mockClaim = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ ready: mockReady, claim: mockClaim })),
  syncBeads: mockSyncBeads,
}));

const mockStatus = vi.fn<() => Promise<{ modified: string[]; staged: string[]; untracked: string[] }>>();
const mockBranchExists = vi.fn<() => Promise<boolean>>();
const mockCheckout = vi.fn<() => Promise<void>>();
const mockPull = vi.fn<() => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({ status: mockStatus, branchExists: mockBranchExists, checkout: mockCheckout, pull: mockPull })),
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

// ── imports after mocks ──────────────────────────────────────────────────────

const { parseReadyOutput, pickNext, preFlightCheck, selectNext, prepareTask, PreFlightError } =
  await import('./pickup.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git', mode: 'embedded' },
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
  mockReady.mockResolvedValue('[]');
  mockClaim.mockResolvedValue('');
  mockSyncBeads.mockResolvedValue(undefined);
  mockStatus.mockResolvedValue({ modified: [], staged: [], untracked: [] });
  mockBranchExists.mockResolvedValue(false);
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
});

// ── pickup ────────────────────────────────────────────────────────────────────

describe('selectNext (read-only)', () => {
  it('returns null when bd ready returns no tasks', async () => {
    mockReady.mockResolvedValue('[]');
    expect(await selectNext(KSHETRA)).toBeNull();
  });

  it('returns the highest-priority ready task', async () => {
    const p0Issue = makeIssue({ id: 'p0-task', title: 'P0 hotfix', priority: 0 });
    const p2Issue = makeIssue({ id: 'p2-task', title: 'Add feature', priority: 2 });
    mockReady.mockResolvedValue(JSON.stringify([p2Issue, p0Issue]));
    const result = await selectNext(KSHETRA);
    expect(result?.id).toBe('p0-task');
  });

  it('performs NO git ops, no claim, and no beads sync (pure read)', async () => {
    mockReady.mockResolvedValue(JSON.stringify([makeIssue()]));
    await selectNext(KSHETRA);
    expect(mockSyncBeads).not.toHaveBeenCalled();
    expect(mockCheckout).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe('prepareTask (the only mutator)', () => {
  const TASK: Task = { id: 'proj-123', slug: 'fix-login-bug', title: 'Fix login bug', status: 'pending', priority: 2 };

  it('syncs beads before touching the work tree', async () => {
    const order: string[] = [];
    mockSyncBeads.mockImplementation(async () => { order.push('sync'); });
    mockCheckout.mockImplementation(async () => { order.push('checkout'); });
    await prepareTask(TASK, KSHETRA);
    expect(order.indexOf('sync')).toBeLessThan(order.indexOf('checkout'));
  });

  it('claims the task and returns it when preflight + health pass', async () => {
    const result = await prepareTask(TASK, KSHETRA);
    expect(mockClaim).toHaveBeenCalledWith('proj-123');
    expect(result?.id).toBe('proj-123');
  });

  it('returns null (without claiming) when preFlightCheck fails', async () => {
    mockStatus.mockResolvedValue({ modified: ['src/dirty.ts'], staged: [], untracked: [] });
    const result = await prepareTask(TASK, KSHETRA);
    expect(result).toBeNull();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('logs a warning naming the bead and reason when preflight rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockBranchExists.mockResolvedValue(true); // leftover branch → preflight rejects
    await prepareTask(TASK, KSHETRA);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj-123'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('branch already exists'));
    warn.mockRestore();
  });

  it('rethrows non-PreFlightError exceptions from preFlightCheck', async () => {
    mockStatus.mockRejectedValue(new Error('git crash'));
    await expect(prepareTask(TASK, KSHETRA)).rejects.toThrow('git crash');
  });

  it('claim is NOT called before preFlightCheck passes', async () => {
    const callOrder: string[] = [];
    mockStatus.mockImplementation(async () => { callOrder.push('status'); return { modified: [], staged: [], untracked: [] }; });
    mockClaim.mockImplementation(async () => { callOrder.push('claim'); return ''; });
    await prepareTask(TASK, KSHETRA);
    expect(callOrder.indexOf('status')).toBeLessThan(callOrder.indexOf('claim'));
  });

  // ── health gate ──────────────────────────────────────────────────────────

  it('does not claim a feature task when the base suite is red', async () => {
    mockCheckHealth.mockResolvedValue({ green: false, failCount: 3, baseline: 0, sha: 'sha' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await prepareTask(TASK, KSHETRA);
    expect(result).toBeNull();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockEnsureHealthBead).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('claims normally when the base suite is green', async () => {
    mockCheckHealth.mockResolvedValue({ green: true, failCount: 0, baseline: 0, sha: 'sha' });
    const result = await prepareTask(TASK, KSHETRA);
    expect(result?.id).toBe('proj-123');
    expect(mockClaim).toHaveBeenCalledWith('proj-123');
    expect(mockEnsureHealthBead).not.toHaveBeenCalled();
  });

  it('a health bead bypasses the gate and is claimed even when the suite is red', async () => {
    mockIsHealthBead.mockReturnValue(true);
    const result = await prepareTask(TASK, KSHETRA);
    expect(result?.id).toBe('proj-123');
    expect(mockClaim).toHaveBeenCalledWith('proj-123');
    expect(mockCheckHealth).not.toHaveBeenCalled();
  });
});
