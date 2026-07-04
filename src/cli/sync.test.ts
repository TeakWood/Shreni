import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockSyncBeads = vi.fn<(k: KshetraConfig) => Promise<void>>();
vi.mock('../sthapathi/beads', () => ({ syncBeads: mockSyncBeads }));

// ── imports after mocks ───────────────────────────────────────────────────────

const { runSync } = await import('./sync');

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
  mockSyncBeads.mockResolvedValue(undefined);
});

// ── runSync ───────────────────────────────────────────────────────────────────

describe('runSync', () => {
  it('prints "No kshetras registered." when registry is empty', async () => {
    mockLoadRegistry.mockReturnValue([]);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSync({ all: false });
    expect(spy).toHaveBeenCalledWith('No kshetras registered.');
    expect(mockSyncBeads).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('syncs the specified kshetra when --kshetra is provided', async () => {
    mockLoadRegistry.mockReturnValue([K1, K2]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSync({ kshetraId: 'alpha', all: false });
    expect(mockSyncBeads).toHaveBeenCalledOnce();
    expect(mockSyncBeads).toHaveBeenCalledWith(K1);
    logSpy.mockRestore();
  });

  it('syncs all kshetras when --all is set', async () => {
    mockLoadRegistry.mockReturnValue([K1, K2]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSync({ all: true });
    expect(mockSyncBeads).toHaveBeenCalledTimes(2);
    expect(mockSyncBeads).toHaveBeenCalledWith(K1);
    expect(mockSyncBeads).toHaveBeenCalledWith(K2);
    logSpy.mockRestore();
  });

  it('exits with error when --kshetra id is not registered', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runSync({ kshetraId: 'ghost', all: false })).rejects.toThrow('exit');
    expect(mockSyncBeads).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits with usage error when no filter is provided', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runSync({ all: false })).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('does not run any tasks — only calls syncBeads', async () => {
    mockLoadRegistry.mockReturnValue([K1]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSync({ kshetraId: 'alpha', all: false });
    // syncBeads is called; no pickup or dispatch imports exist in sync.ts
    expect(mockSyncBeads).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('syncs each kshetra sequentially and logs progress', async () => {
    mockLoadRegistry.mockReturnValue([K1, K2]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSync({ all: true });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Alpha');
    expect(output).toContain('Beta');
    logSpy.mockRestore();
  });
});