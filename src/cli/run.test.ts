import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockIsKshetraManuallyPaused = vi.fn<(k: KshetraConfig) => boolean>();
vi.mock('../kshetra/state', () => ({ isKshetraManuallyPaused: mockIsKshetraManuallyPaused }));

const mockPickup = vi.fn<(k: KshetraConfig) => Promise<Task | null>>();
vi.mock('../sthapathi/pickup', () => ({ pickup: mockPickup }));

const mockRunSilpiViharapalaLoop = vi.fn<() => Promise<{ approved: boolean; note: string }>>();
vi.mock('../sthapathi/dispatch', () => ({ runSilpiViharapalaLoop: mockRunSilpiViharapalaLoop }));

const mockHandleCycleError = vi.fn<() => Promise<void>>();
vi.mock('../sthapathi/errors', () => ({ handleCycleError: mockHandleCycleError }));

vi.mock('../sthapathi/branch', () => ({ branchName: (t: Task) => `bead-${t.id}/slug` }));

const mockRunCycle = vi.fn<() => Promise<void>>();
vi.mock('../sthapathi/index', () => ({
  createScheduler: () => ({ runCycle: mockRunCycle }),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { runManualCycle } = await import('./run');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'sishya', name: 'Sishya',
  repo: { path: '/p/sishya', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/p/sishya-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' }, conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadRegistry.mockReturnValue([KSHETRA]);
  mockIsKshetraManuallyPaused.mockReturnValue(false);
  mockRunCycle.mockResolvedValue(undefined);
});

// ── runManualCycle ────────────────────────────────────────────────────────────

describe('runManualCycle', () => {
  it('throws when kshetra id is not registered', async () => {
    mockLoadRegistry.mockReturnValue([]);
    await expect(runManualCycle('ghost')).rejects.toThrow('Kshetra not found: ghost');
  });

  it('calls scheduler.runCycle for the matched kshetra', async () => {
    await runManualCycle('sishya');
    expect(mockRunCycle).toHaveBeenCalledOnce();
  });

  it('passes a pickNext hook that returns null when kshetra is manually paused', async () => {
    mockIsKshetraManuallyPaused.mockReturnValue(true);

    await runManualCycle('sishya');

    // Capture the hooks object passed to runCycle
    const hooks = mockRunCycle.mock.calls[0]?.[1];
    const result = await hooks?.pickNext(KSHETRA);
    expect(result).toBeNull();
    expect(mockPickup).not.toHaveBeenCalled();
  });

  it('passes a pickNext hook that calls pickup when not paused', async () => {
    mockIsKshetraManuallyPaused.mockReturnValue(false);
    mockPickup.mockResolvedValue(null);

    await runManualCycle('sishya');

    const hooks = mockRunCycle.mock.calls[0]?.[1];
    await hooks?.pickNext(KSHETRA);
    expect(mockPickup).toHaveBeenCalledWith(KSHETRA);
  });

  it('passes a runTask hook that calls runSilpiViharapalaLoop with branchName', async () => {
    mockRunSilpiViharapalaLoop.mockResolvedValue({ approved: true, note: 'ok' });
    const task = { id: 'bd-1', slug: 'fix', title: 'Fix', status: 'in_progress', priority: 1 } as Task;

    await runManualCycle('sishya');

    const hooks = mockRunCycle.mock.calls[0]?.[1];
    await hooks?.runTask(task, KSHETRA);
    expect(mockRunSilpiViharapalaLoop).toHaveBeenCalledWith(KSHETRA, task, 'bead-bd-1/slug');
  });

  it('passes a runTask hook that calls handleCycleError on dispatch failure', async () => {
    const boom = new Error('API down');
    mockRunSilpiViharapalaLoop.mockRejectedValue(boom);
    const task = { id: 'bd-2', slug: 'work', title: 'Work', status: 'in_progress', priority: 1 } as Task;

    await runManualCycle('sishya');

    const hooks = mockRunCycle.mock.calls[0]?.[1];
    await hooks?.runTask(task, KSHETRA);
    expect(mockHandleCycleError).toHaveBeenCalledWith(KSHETRA, task, boom);
  });
});