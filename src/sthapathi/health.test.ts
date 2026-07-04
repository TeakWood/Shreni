import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => (mockExecFile as (...a: unknown[]) => void)(...args),
}));

const mockHeadSha = vi.fn<() => Promise<string>>();
vi.mock('./git.js', () => ({
  git: vi.fn(() => ({ headSha: mockHeadSha })),
}));

const mockList = vi.fn<() => Promise<string>>();
const mockCreate = vi.fn<() => Promise<string>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ list: mockList, create: mockCreate })),
}));

const mockGetBaseline = vi.fn<() => number>();
vi.mock('../kshetra/state.js', () => ({
  getHealthBaseline: () => mockGetBaseline(),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

const {
  parseFailCount,
  isHealthBead,
  runTestSuite,
  checkHealth,
  ensureHealthBead,
  invalidateHealth,
  HEALTH_BEAD_PREFIX,
} = await import('./health.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'r', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'r', mode: 'embedded' },
  stack: { language: 'typescript', testRunner: 'pnpm test' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'proj-1', slug: 'x', title: 'Fix bug', status: 'pending', priority: 2, ...overrides };
}

// Make the mocked execFile behave like the callback-style fn promisify expects.
function execResolves(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: (e: unknown, r?: unknown) => void) => {
    cb(null, { stdout, stderr });
  });
}
function execRejects(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: (e: unknown) => void) => {
    cb(Object.assign(new Error('exit 1'), { stdout, stderr }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateHealth(KSHETRA);
  mockHeadSha.mockResolvedValue('sha-aaa');
  mockGetBaseline.mockReturnValue(0);
  mockList.mockResolvedValue('[]');
  mockCreate.mockResolvedValue('');
});

// ── parseFailCount ────────────────────────────────────────────────────────────

describe('parseFailCount', () => {
  it('parses vitest summary', () => {
    expect(parseFailCount('Tests  2 failed | 30 passed (32)')).toBe(2);
  });
  it('parses jest summary', () => {
    expect(parseFailCount('Tests:       5 failed, 30 passed, 35 total')).toBe(5);
  });
  it('parses pytest summary', () => {
    expect(parseFailCount('=== 2 failed, 30 passed in 1.2s ===')).toBe(2);
  });
  it('parses cargo summary', () => {
    expect(parseFailCount('test result: FAILED. 30 passed; 3 failed;')).toBe(3);
  });
  it('returns -1 when no count present', () => {
    expect(parseFailCount('everything is on fire')).toBe(-1);
  });
  it('honours a stack.failCountPattern override before the built-ins', () => {
    expect(parseFailCount('problems=7 here', '(\\d+) problems')).toBe(-1);
    expect(parseFailCount('problems=7 here', 'problems=(\\d+)')).toBe(7);
  });
  it('ignores a malformed override and falls back to the built-ins', () => {
    expect(parseFailCount('Tests  4 failed', '([')).toBe(4);
  });
});

// ── isHealthBead ──────────────────────────────────────────────────────────────

describe('isHealthBead', () => {
  it('detects the health prefix', () => {
    expect(isHealthBead(task({ title: `${HEALTH_BEAD_PREFIX} Restore green test suite` }))).toBe(true);
  });
  it('rejects ordinary tasks', () => {
    expect(isHealthBead(task({ title: 'Fix login bug' }))).toBe(false);
  });
});

// ── runTestSuite ──────────────────────────────────────────────────────────────

describe('runTestSuite', () => {
  it('reports passed on exit 0', async () => {
    execResolves('Tests  30 passed (30)');
    const r = await runTestSuite(KSHETRA);
    expect(r.passed).toBe(true);
    expect(r.failCount).toBe(0);
  });

  it('reports fail count on nonzero exit', async () => {
    execRejects('Tests  3 failed | 27 passed (30)');
    const r = await runTestSuite(KSHETRA);
    expect(r.passed).toBe(false);
    expect(r.failCount).toBe(3);
  });
});

// ── checkHealth (gate + cache) ────────────────────────────────────────────────

describe('checkHealth', () => {
  it('is green when the suite passes', async () => {
    execResolves('all good 30 passed');
    const h = await checkHealth(KSHETRA);
    expect(h.green).toBe(true);
    expect(h.failCount).toBe(0);
  });

  it('is red when failures exceed the baseline', async () => {
    execRejects('Tests  3 failed | 27 passed (30)');
    const h = await checkHealth(KSHETRA);
    expect(h.green).toBe(false);
    expect(h.failCount).toBe(3);
  });

  it('is green when failures are within the accepted baseline', async () => {
    mockGetBaseline.mockReturnValue(3);
    execRejects('Tests  3 failed | 27 passed (30)');
    const h = await checkHealth(KSHETRA);
    expect(h.green).toBe(true);
  });

  it('caches by HEAD sha — does not re-run while sha is unchanged', async () => {
    execRejects('Tests  3 failed | 27 passed (30)');
    await checkHealth(KSHETRA);
    await checkHealth(KSHETRA);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('re-runs when HEAD sha moves', async () => {
    execRejects('Tests  3 failed | 27 passed (30)');
    await checkHealth(KSHETRA);
    mockHeadSha.mockResolvedValue('sha-bbb');
    await checkHealth(KSHETRA);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

// ── ensureHealthBead ──────────────────────────────────────────────────────────

describe('ensureHealthBead', () => {
  it('creates a P0 health bead when none is open', async () => {
    const created = await ensureHealthBead(KSHETRA, 3);
    expect(created).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [title, priority] = mockCreate.mock.calls[0] as unknown as [string, number, string];
    expect(title.startsWith(HEALTH_BEAD_PREFIX)).toBe(true);
    expect(priority).toBe(0);
  });

  it('does not duplicate when a health bead already exists', async () => {
    mockList.mockResolvedValue(JSON.stringify([{ id: 'h-1', title: `${HEALTH_BEAD_PREFIX} Restore green test suite` }]));
    const created = await ensureHealthBead(KSHETRA, 3);
    expect(created).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
