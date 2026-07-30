import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from './config';

// ── module mocks ─────────────────────────────────────────────────────────────
// assembleKshetraStatus reads liveness (../cli/pid), runtime state (./state) and
// bead queues (../sthapathi/beads). Mock those so the shared module can be tested
// in isolation — exactly how Phalaka will consume it, importing directly from
// '../kshetra/status' rather than through the CLI.

const mockReadPid = vi.fn<() => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
vi.mock('../cli/pid', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
}));

const mockLoadState = vi.fn();
vi.mock('./state', () => ({ loadState: mockLoadState }));

const mockBdList = vi.fn<(filters: { status?: string; label?: string }) => Promise<string>>();
const mockBdReady = vi.fn<() => Promise<string>>();
vi.mock('../sthapathi/beads', () => ({
  bd: vi.fn(() => ({ list: mockBdList, ready: mockBdReady })),
}));

const { assembleKshetraStatus } = await import('./status');

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}', prFollowupMaxRounds: 4 },
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

describe('assembleKshetraStatus (shared module, direct import)', () => {
  it('reports the worker stopped when there is no live pid', async () => {
    const info = await assembleKshetraStatus(KSHETRA);
    expect(info.daemonRunning).toBe(false);
    expect(info.pid).toBeUndefined();
  });

  it('reports the worker running with its pid when alive', async () => {
    mockReadPid.mockReturnValue(4242);
    mockIsAlive.mockReturnValue(true);
    const info = await assembleKshetraStatus(KSHETRA);
    expect(info.daemonRunning).toBe(true);
    expect(info.pid).toBe(4242);
  });

  it('surfaces phase/paused/stuck from state.json and derives queue depth', async () => {
    mockLoadState.mockReturnValue({
      kshetras: {
        myapp: {
          phase: 'WORKING',
          paused: true,
          reason: 'stuck',
          requiresManualResume: true,
          stuck: { since: '2026-06-30T00:00:00.000Z', reason: 'hung', remediation: 'resume' },
        },
      },
    });
    mockBdReady.mockResolvedValue(JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    const info = await assembleKshetraStatus(KSHETRA);
    expect(info.phase).toBe('WORKING');
    expect(info.paused).toBe(true);
    expect(info.pauseReason).toBe('stuck');
    expect(info.requiresManualResume).toBe(true);
    expect(info.stuck?.reason).toBe('hung');
    expect(info.queueDepth).toBe(2);
  });
});
