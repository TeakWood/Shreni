import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockReadPid = vi.fn<() => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
vi.mock('./pid', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
  writePid: vi.fn(),
  clearPid: vi.fn(),
  PID_PATH: '/tmp/shreni.pid',
}));

const mockLoadState = vi.fn();
vi.mock('../kshetra/state', () => ({ loadState: mockLoadState }));

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockBdList = vi.fn<(filters: { status?: string }) => Promise<string>>();
const mockBdReady = vi.fn<() => Promise<string>>();
vi.mock('../sthapathi/beads', () => ({
  bd: vi.fn(() => ({ list: mockBdList, ready: mockBdReady })),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { resolveKshetra, getKshetraStatus, formatKshetraStatus, formatAge, runStatus, resumeHint } =
  await import('./status');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockReadPid.mockReturnValue(null);
  mockIsAlive.mockReturnValue(false);
  mockLoadState.mockReturnValue({ kshetras: {} });
  mockBdList.mockResolvedValue('[]');
  mockBdReady.mockResolvedValue('[]');
});

// ── resolveKshetra ────────────────────────────────────────────────────────────

describe('resolveKshetra', () => {
  it('returns matching kshetra when cwd is inside repo.path', () => {
    const result = resolveKshetra([KSHETRA], '/projects/myapp/src/foo');
    expect(result?.id).toBe('myapp');
  });

  it('returns matching kshetra when cwd equals repo.path', () => {
    const result = resolveKshetra([KSHETRA], '/projects/myapp');
    expect(result?.id).toBe('myapp');
  });

  it('returns null when cwd is outside all kshetras', () => {
    const result = resolveKshetra([KSHETRA], '/home/user/other');
    expect(result).toBeNull();
  });

  it('returns longest-match kshetra when two repos nest', () => {
    const child = { ...KSHETRA, id: 'child', repo: { ...KSHETRA.repo, path: '/projects/myapp/sub' } };
    const result = resolveKshetra([KSHETRA, child], '/projects/myapp/sub/src');
    expect(result?.id).toBe('child');
  });
});

// ── getKshetraStatus ──────────────────────────────────────────────────────────

describe('getKshetraStatus', () => {
  it('reports daemon not running when no PID file', async () => {
    mockReadPid.mockReturnValue(null);
    const info = await getKshetraStatus(KSHETRA);
    expect(info.daemonRunning).toBe(false);
  });

  it('reports daemon running when PID is alive', async () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);
    const info = await getKshetraStatus(KSHETRA);
    expect(info.daemonRunning).toBe(true);
  });

  it('reports paused with reason when kshetra is paused', async () => {
    mockLoadState.mockReturnValue({
      kshetras: {
        myapp: { paused: true, reason: 'api_down', message: 'Service unavailable', requiresManualResume: false },
      },
    });
    const info = await getKshetraStatus(KSHETRA);
    expect(info.paused).toBe(true);
    expect(info.pauseReason).toBe('api_down');
    expect(info.pauseMessage).toBe('Service unavailable');
  });

  it('reports not paused when kshetra state is absent', async () => {
    mockLoadState.mockReturnValue({ kshetras: {} });
    const info = await getKshetraStatus(KSHETRA);
    expect(info.paused).toBe(false);
  });

  it('populates activeBead from in_progress beads list', async () => {
    mockBdList.mockImplementation(({ status } = {}) => {
      if (status === 'in_progress') {
        return Promise.resolve(JSON.stringify([{ id: 'bd-1', title: 'Fix login', status: 'in_progress', notes: 'Round 2: dispatching Silpi' }]));
      }
      return Promise.resolve('[]');
    });
    const info = await getKshetraStatus(KSHETRA);
    expect(info.activeBead).toEqual({ id: 'bd-1', title: 'Fix login', agent: 'Silpi', round: 2 });
  });

  it('parses round without agent when note has no dispatching keyword', async () => {
    mockBdList.mockImplementation(({ status } = {}) => {
      if (status === 'in_progress') {
        return Promise.resolve(JSON.stringify([{ id: 'bd-2', title: 'Add tests', status: 'in_progress', notes: 'Round 1: claiming' }]));
      }
      return Promise.resolve('[]');
    });
    const info = await getKshetraStatus(KSHETRA);
    expect(info.activeBead?.round).toBe(1);
    expect(info.activeBead?.agent).toBeUndefined();
  });

  it('returns undefined activeBead when no in_progress beads', async () => {
    mockBdList.mockResolvedValue('[]');
    const info = await getKshetraStatus(KSHETRA);
    expect(info.activeBead).toBeUndefined();
  });

  it('reports queue depth from ready count', async () => {
    mockBdReady.mockResolvedValue(JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));
    const info = await getKshetraStatus(KSHETRA);
    expect(info.queueDepth).toBe(3);
  });

  it('reports last completed from closed list', async () => {
    mockBdList.mockImplementation(({ status } = {}) => {
      if (status === 'closed') {
        return Promise.resolve(JSON.stringify([
          { id: 'old', title: 'Old task', status: 'closed' },
          { id: 'recent', title: 'Recent task', status: 'closed' },
        ]));
      }
      return Promise.resolve('[]');
    });
    const info = await getKshetraStatus(KSHETRA);
    expect(info.lastCompleted).toEqual({ id: 'recent', title: 'Recent task' });
  });

  it('handles bd errors gracefully (returns zeros/undefined)', async () => {
    mockBdList.mockRejectedValue(new Error('bd unreachable'));
    mockBdReady.mockRejectedValue(new Error('bd unreachable'));
    const info = await getKshetraStatus(KSHETRA);
    expect(info.activeBead).toBeUndefined();
    expect(info.queueDepth).toBe(0);
    expect(info.lastCompleted).toBeUndefined();
  });
});

// ── formatKshetraStatus ───────────────────────────────────────────────────────

describe('formatKshetraStatus', () => {
  const BASE = {
    kshetra: KSHETRA,
    daemonRunning: false,
    paused: false,
    queueDepth: 0,
  };

  it('shows worker stopped when not running', () => {
    const out = formatKshetraStatus({ ...BASE, daemonRunning: false });
    expect(out).toContain('worker stopped');
  });

  it('shows worker running with pid when alive', () => {
    const out = formatKshetraStatus({ ...BASE, daemonRunning: true, pid: 4242 });
    expect(out).toContain('worker running (pid 4242)');
  });

  it('shows active status when not paused', () => {
    const out = formatKshetraStatus({ ...BASE, paused: false });
    expect(out).toContain('Status:  active');
  });

  it('shows paused status with reason', () => {
    const out = formatKshetraStatus({ ...BASE, paused: true, pauseReason: 'api_down', pauseMessage: 'Unavailable' });
    expect(out).toContain('paused (api_down)');
    expect(out).toContain('Unavailable');
  });

  it('shows plain resume hint when requiresManualResume and reason is not stuck', () => {
    const out = formatKshetraStatus({ ...BASE, paused: true, pauseReason: 'git_failed', requiresManualResume: true });
    expect(out).toContain('Requires manual resume: shreni resume');
    expect(out).not.toContain('self-heals');
  });

  it('shows a self-heal resume hint for a reason:stuck pause (resume recovers in-process)', () => {
    const out = formatKshetraStatus({ ...BASE, paused: true, pauseReason: 'stuck', requiresManualResume: true });
    expect(out).toContain('shreni resume --kshetra myapp');
    expect(out).toContain('self-heals');
  });

  it('shows active bead with agent and round', () => {
    const out = formatKshetraStatus({ ...BASE, activeBead: { id: 'bd-1', title: 'Fix login', agent: 'Silpi', round: 2 } });
    expect(out).toContain('bd-1');
    expect(out).toContain('Fix login');
    expect(out).toContain('Agent: Silpi');
    expect(out).toContain('Round: 2');
  });

  it('shows "none" when no active bead', () => {
    const out = formatKshetraStatus({ ...BASE, activeBead: undefined });
    expect(out).toContain('Active bead: none');
  });

  it('shows queue depth', () => {
    const out = formatKshetraStatus({ ...BASE, queueDepth: 5 });
    expect(out).toContain('Queue depth: 5');
  });

  it('shows last completed when present', () => {
    const out = formatKshetraStatus({ ...BASE, lastCompleted: { id: 'bd-99', title: 'Old feature' } });
    expect(out).toContain('bd-99');
    expect(out).toContain('Old feature');
  });

  it('shows the current phase when active', () => {
    const out = formatKshetraStatus({ ...BASE, paused: false, phase: 'WORKING' });
    expect(out).toContain('Status:  active · phase WORKING');
  });

  it('shows a STUCK banner with reason and remediation', () => {
    const out = formatKshetraStatus({
      ...BASE,
      stuck: { since: '2026-06-30T00:00:00.000Z', reason: 'agent appears hung', remediation: '  1) restart it' },
    });
    expect(out).toContain('STUCK');
    expect(out).toContain('agent appears hung');
    expect(out).toContain('restart it');
  });

  it('shows last progress age when present', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = formatKshetraStatus({ ...BASE, lastProgressAt: recent });
    expect(out).toContain('Last progress: 5m ago');
  });
});

describe('resumeHint', () => {
  it('tells a stuck pause that plain resume self-heals in-process', () => {
    expect(resumeHint('stuck', 'myapp')).toBe(
      'Requires manual resume: shreni resume --kshetra myapp (worker self-heals the hung agent)',
    );
  });

  it('uses plain resume for api_down / git_failed / bd_failed / manual / undefined', () => {
    for (const reason of ['api_down', 'git_failed', 'bd_failed', 'manual', undefined]) {
      expect(resumeHint(reason, 'myapp')).toBe('Requires manual resume: shreni resume');
    }
  });
});

describe('formatAge', () => {
  const base = Date.parse('2026-06-30T12:00:00.000Z');
  it('returns "" for undefined or future', () => {
    expect(formatAge(undefined, base)).toBe('');
    expect(formatAge('2026-06-30T13:00:00.000Z', base)).toBe('');
  });
  it('formats minutes, hours, days', () => {
    expect(formatAge('2026-06-30T11:48:00.000Z', base)).toBe('12m ago');
    expect(formatAge('2026-06-30T09:00:00.000Z', base)).toBe('3h ago');
    expect(formatAge('2026-06-28T12:00:00.000Z', base)).toBe('2d ago');
  });
  it('says "just now" under a minute', () => {
    expect(formatAge('2026-06-30T11:59:40.000Z', base)).toBe('just now');
  });
});

// ── runStatus ─────────────────────────────────────────────────────────────────

describe('runStatus', () => {
  it('prints "no kshetras" when registry is empty', async () => {
    mockLoadRegistry.mockReturnValue([]);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runStatus({ all: false, cwd: '/anywhere' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('No kshetras registered'));
    spy.mockRestore();
  });

  it('exits with error when cwd does not match any kshetra', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runStatus({ all: false, cwd: '/unrelated/path' })).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('runs status for cwd-matched kshetra', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runStatus({ all: false, cwd: '/projects/myapp/src' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('myapp'));
    logSpy.mockRestore();
  });

  it('runs status for all kshetras when --all', async () => {
    const other = { ...KSHETRA, id: 'other', name: 'Other', repo: { ...KSHETRA.repo, path: '/projects/other' } };
    mockLoadRegistry.mockReturnValue([KSHETRA, other]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runStatus({ all: true, cwd: '/anywhere' });
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('myapp');
    expect(allOutput).toContain('other');
    logSpy.mockRestore();
  });
});