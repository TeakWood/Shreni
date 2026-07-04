import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

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

const mockBdList = vi.fn<(f: { status?: string }) => Promise<string>>();
const mockBdReady = vi.fn<() => Promise<string>>();
vi.mock('../sthapathi/beads', () => ({
  bd: vi.fn(() => ({ list: mockBdList, ready: mockBdReady })),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { getAgentLines, formatAgentLines } = await import('./agents');

// ── fixtures ──────────────────────────────────────────────────────────────────

const K1 = {
  id: 'alpha', name: 'Alpha',
  repo: { path: '/p/alpha', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/p/alpha-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' }, conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

const K2 = { ...K1, id: 'beta', name: 'Beta', repo: { ...K1.repo, path: '/p/beta' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockReadPid.mockReturnValue(null);
  mockIsAlive.mockReturnValue(false);
  mockLoadState.mockReturnValue({ kshetras: {} });
  mockBdList.mockResolvedValue('[]');
  mockBdReady.mockResolvedValue('[]');
});

// ── getAgentLines ─────────────────────────────────────────────────────────────

describe('getAgentLines', () => {
  it('returns one line per kshetra', async () => {
    mockLoadRegistry.mockReturnValue([K1, K2]);
    const lines = await getAgentLines();
    expect(lines).toHaveLength(2);
  });

  it('marks daemon running when PID is alive', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);
    const [line] = await getAgentLines();
    expect(line?.daemonRunning).toBe(true);
  });

  it('marks daemon stopped when no PID', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    const [line] = await getAgentLines();
    expect(line?.daemonRunning).toBe(false);
  });

  it('populates agent and round from in_progress bead notes', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    mockBdList.mockImplementation(({ status } = {}) =>
      status === 'in_progress'
        ? Promise.resolve(JSON.stringify([{ id: 'bd-5', title: 'Do work', status: 'in_progress', notes: 'Round 3: dispatching Viharapala' }]))
        : Promise.resolve('[]'),
    );
    const [line] = await getAgentLines();
    expect(line?.beadId).toBe('bd-5');
    expect(line?.agent).toBe('Viharapala');
    expect(line?.round).toBe(3);
  });

  it('marks kshetra paused when state is paused', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    mockLoadState.mockReturnValue({ kshetras: { alpha: { paused: true, requiresManualResume: true } } });
    const [line] = await getAgentLines();
    expect(line?.paused).toBe(true);
  });
});

// ── formatAgentLines ──────────────────────────────────────────────────────────

describe('formatAgentLines', () => {
  it('returns "No kshetras registered." for empty list', () => {
    expect(formatAgentLines([])).toBe('No kshetras registered.');
  });

  it('shows idle when no active bead', () => {
    const out = formatAgentLines([
      { kshetraId: 'alpha', kshetraName: 'Alpha', daemonRunning: true, paused: false },
    ]);
    expect(out).toContain('idle');
  });

  it('shows paused label when kshetra is paused', () => {
    const out = formatAgentLines([
      { kshetraId: 'alpha', kshetraName: 'Alpha', daemonRunning: false, paused: true },
    ]);
    expect(out).toContain('paused');
  });

  it('shows bead id, title, agent, and round when active', () => {
    const out = formatAgentLines([{
      kshetraId: 'alpha', kshetraName: 'Alpha', daemonRunning: true, paused: false,
      beadId: 'bd-7', beadTitle: 'Fix bug', agent: 'Silpi', round: 2,
    }]);
    expect(out).toContain('bd-7');
    expect(out).toContain('Fix bug');
    expect(out).toContain('Silpi');
    expect(out).toContain('Round 2');
  });

  it('omits agent bracket when no agent info', () => {
    const out = formatAgentLines([{
      kshetraId: 'alpha', kshetraName: 'Alpha', daemonRunning: true, paused: false,
      beadId: 'bd-1', beadTitle: 'Task', agent: undefined, round: undefined,
    }]);
    expect(out).toContain('bd-1');
    // No [AgentName, Round N] bracket — only the [running] status bracket is present
    expect(out).not.toMatch(/\[\w+, Round \d+\]/);
    expect(out).not.toMatch(/\[Silpi\]|\[Viharapala\]/);
  });
});