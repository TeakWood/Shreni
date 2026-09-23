import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import type { Scheduler } from '../sthapathi/index';
import type { WorkerRuntime } from './worker-runtime';

// runDrain wiring: it must RECORD the drain_finished outcome and then PUSH it
// (final sync) before returning — the trial's outcome belongs in the git-tracked,
// pushed ledger. These mocks isolate that glue from bd/git/agents.

const KSHETRA: KshetraConfig = {
  id: 'myapp', name: 'Myapp',
  repo: { path: '/p', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/pb', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' }, conventions: {},
  agents: { model: 'm', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const order: string[] = [];
const mockEmit = vi.fn((e: { type: string }) => { order.push(`emit:${e.type}`); });
vi.mock('../sthapathi/activity-log', () => ({
  emit: (e: { type: string }) => mockEmit(e),
  getCurrentLotId: () => 'lot-xyz',
}));
vi.mock('../kshetra/registry', () => ({ loadRegistry: () => [KSHETRA] }));
vi.mock('../kshetra/state', () => ({ loadState: () => ({ kshetras: {} }) }));
// workerPreconditionError → null (clear to run); createWorkerRuntime is unused
// because the test injects makeDriver.
vi.mock('./worker-runtime', () => ({
  workerPreconditionError: () => null,
  createWorkerRuntime: () => { throw new Error('should not be called — driver injected'); },
}));

const { runDrain } = await import('./drain');
type DrainDriver = import('./drain').DrainDriver;

function fakeDriver(openInScope: string[]): DrainDriver {
  const runtime: WorkerRuntime = {
    kshetra: KSHETRA,
    scheduler: { runCycle: vi.fn(async () => 'no-work' as const) } as unknown as Scheduler,
    hooks: {} as WorkerRuntime['hooks'],
    startup: vi.fn(async () => 0),
    sync: vi.fn(async () => { order.push('sync'); }),
    startTimers: () => () => { order.push('stopTimers'); },
    isInFlight: () => false,
    isHealing: () => false,
  };
  return {
    runtime,
    openInScope: vi.fn(async () => openInScope),
    classify: vi.fn(async (ids: string[]) => ids.map(id => ({ beadId: id, category: 'needs-human' as const, reason: 'needs-human' }))),
    counts: vi.fn(async (_sinceMs: number) => ({ filed: 0, merged: 3, outOfScopeFiled: [] })),
  };
}

beforeEach(() => { order.length = 0; mockEmit.mockClear(); });

describe('runDrain', () => {
  it('throws for an unknown kshetra', async () => {
    await expect(runDrain('ghost', {}, async () => fakeDriver([]))).rejects.toThrow('Kshetra not found: ghost');
  });

  it('records drain_finished and PUSHES it (final sync) before returning — complete', async () => {
    const result = await runDrain('myapp', { intervalMs: 1 }, async () => fakeDriver([]), async () => {});
    expect(result).toMatchObject({ exitCode: 0, reason: 'complete', lotId: 'lot-xyz', counts: { merged: 3, open: 0 } });
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'drain_finished', reason: 'complete' }));
    // Ordering: the drain_finished emit precedes the FINAL sync that pushes it.
    const lastSync = order.lastIndexOf('sync');
    expect(order.indexOf('emit:drain_finished')).toBeLessThan(lastSync);
  });

  it('carries per-bead classification into drain_finished for a stalled drain', async () => {
    const result = await runDrain('myapp', { intervalMs: 1, epic: 'epic-1' }, async () => fakeDriver(['mid']), async () => {});
    expect(result).toMatchObject({ exitCode: 10, reason: 'stalled', scope: 'epic-1' });
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'drain_finished', reason: 'stalled', scope: 'epic-1',
      stalled: [{ beadId: 'mid', reason: 'needs-human' }],
    }));
  });

  // --max-cycles (Shreni-beads-nhw): the cap drives the loop through the injected
  // driver and the FULL exit sequence still runs — classification, exit code,
  // drain_finished (carrying the cap), then the final sync that pushes it.
  it('--max-cycles caps the loop and still records + pushes drain_finished', async () => {
    const driver = fakeDriver(['b2']);
    (driver.classify as ReturnType<typeof vi.fn>).mockImplementation(async (ids: string[]) =>
      ids.map(id => ({ beadId: id, category: 'ready-but-unworked' as const, reason: 'READY BUT UNWORKED' })));
    (driver.runtime.scheduler.runCycle as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('cycle');
      return 'ran' as const;
    });
    const result = await runDrain('myapp', { intervalMs: 1, maxCycles: 3 }, async () => driver, async () => {});
    expect(order.filter(o => o === 'cycle')).toHaveLength(3);
    expect(driver.classify).toHaveBeenCalledWith(['b2']);
    expect(result).toMatchObject({ exitCode: 12, reason: 'capped', maxCycles: 3, counts: { open: 1 } });
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'drain_finished', reason: 'capped', exitCode: 12, maxCycles: 3,
      stalled: [{ beadId: 'b2', reason: 'ready — not reached before the --max-cycles cap' }],
    }));
    expect(order.indexOf('emit:drain_finished')).toBeLessThan(order.lastIndexOf('sync'));
    expect(order.at(-1)).toBe('stopTimers');
  });

  it('omits maxCycles from drain_finished when uncapped', async () => {
    await runDrain('myapp', { intervalMs: 1 }, async () => fakeDriver([]), async () => {});
    const ev = mockEmit.mock.calls.map(c => c[0]).find(e => e.type === 'drain_finished');
    expect(ev).toBeDefined();
    expect('maxCycles' in (ev as object)).toBe(false);
  });

  it('rejects a non-positive or fractional --max-cycles before driving anything', async () => {
    for (const bad of [0, -1, 1.5]) {
      await expect(runDrain('myapp', { maxCycles: bad }, async () => fakeDriver([]))).rejects.toThrow(/positive integer/);
    }
    expect(order).toEqual([]);
  });
});
