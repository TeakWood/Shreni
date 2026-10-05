import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockBdList = vi.fn<(f: { status?: string }) => Promise<string>>();
const mockBdShow = vi.fn<(id: string) => Promise<string>>();
const mockBd = vi.fn((_k: KshetraConfig) => ({ list: mockBdList, show: mockBdShow }));
vi.mock('../sthapathi/beads', () => ({ bd: mockBd }));

// ── imports after mocks ───────────────────────────────────────────────────────

const { parseNotesToBeadLog, formatBeadLog, runLogs } = await import('./logs');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'myapp', name: 'Myapp',
  repo: { path: '/p/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/p/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' }, conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockBdList.mockResolvedValue('[]');
  mockBdShow.mockRejectedValue(new Error('not found'));
});

// ── parseNotesToBeadLog ───────────────────────────────────────────────────────

describe('parseNotesToBeadLog', () => {
  it('returns empty rounds for undefined notes', () => {
    const log = parseNotesToBeadLog('bd-1', 'Title', 'open', undefined);
    expect(log.rounds).toHaveLength(0);
    expect(log.extra).toHaveLength(0);
  });

  it('groups events by round number', () => {
    const notes = [
      'Round 1: dispatching Silpi',
      'Round 1: Silpi submitted',
      'Round 1: dispatching Viharapala',
      'Round 1: APPROVE',
    ].join('\n');
    const log = parseNotesToBeadLog('bd-1', 'Title', 'closed', notes);
    expect(log.rounds).toHaveLength(1);
    expect(log.rounds[0]?.round).toBe(1);
    expect(log.rounds[0]?.events).toEqual([
      'dispatching Silpi',
      'Silpi submitted',
      'dispatching Viharapala',
      'APPROVE',
    ]);
  });

  it('separates multi-round notes correctly', () => {
    const notes = [
      'Round 1: dispatching Silpi',
      'Round 1: REJECT',
      'Round 2: dispatching Silpi',
      'Round 2: APPROVE',
    ].join('\n');
    const log = parseNotesToBeadLog('bd-1', 'Title', 'closed', notes);
    expect(log.rounds).toHaveLength(2);
    expect(log.rounds[0]?.round).toBe(1);
    expect(log.rounds[1]?.round).toBe(2);
  });

  it('puts non-round lines into extra', () => {
    const notes = 'Round 1: dispatching Silpi\nPaused: API unavailable — timeout. Will retry.';
    const log = parseNotesToBeadLog('bd-1', 'Title', 'in_progress', notes);
    expect(log.extra).toContain('Paused: API unavailable — timeout. Will retry.');
  });

  it('sets beadId, title, and status', () => {
    const log = parseNotesToBeadLog('bd-42', 'Fix login', 'closed', '');
    expect(log.beadId).toBe('bd-42');
    expect(log.title).toBe('Fix login');
    expect(log.status).toBe('closed');
  });
});

// ── formatBeadLog ─────────────────────────────────────────────────────────────

describe('formatBeadLog', () => {
  it('includes bead id, title, and status header', () => {
    const log = parseNotesToBeadLog('bd-1', 'Fix bug', 'closed', '');
    const out = formatBeadLog(log);
    expect(out).toContain('[closed]');
    expect(out).toContain('bd-1');
    expect(out).toContain('Fix bug');
  });

  it('formats round events indented under round header', () => {
    const notes = 'Round 2: dispatching Silpi\nRound 2: Silpi submitted';
    const log = parseNotesToBeadLog('bd-1', 'T', 'open', notes);
    const out = formatBeadLog(log);
    expect(out).toContain('Round 2:');
    expect(out).toContain('dispatching Silpi');
    expect(out).toContain('Silpi submitted');
  });

  it('formats extra lines', () => {
    const notes = 'Paused: API unavailable — timeout.';
    const log = parseNotesToBeadLog('bd-1', 'T', 'open', notes);
    const out = formatBeadLog(log);
    expect(out).toContain('Paused: API unavailable — timeout.');
  });
});

// ── runLogs ───────────────────────────────────────────────────────────────────

describe('runLogs', () => {
  it('prints "No kshetras registered." when registry is empty', async () => {
    mockLoadRegistry.mockReturnValue([]);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ all: false });
    expect(spy).toHaveBeenCalledWith('No kshetras registered.');
    spy.mockRestore();
  });

  it('exits with error when no filter provided', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runLogs({ all: false })).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('shows logs for a kshetra when --kshetra is set', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockBdList.mockResolvedValue(JSON.stringify([
      { id: 'bd-1', title: 'Do work', status: 'in_progress', notes: 'Round 1: dispatching Silpi' },
    ]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ kshetraId: 'myapp', all: false });
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('bd-1');
    expect(output).toContain('dispatching Silpi');
    logSpy.mockRestore();
  });

  it('exits with error when --kshetra id is not registered', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runLogs({ kshetraId: 'ghost', all: false })).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('shows logs for all kshetras when --all', async () => {
    const K2 = { ...KSHETRA, id: 'beta', name: 'Beta' };
    mockLoadRegistry.mockReturnValue([KSHETRA, K2]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ all: true });
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Myapp');
    expect(output).toContain('Beta');
    logSpy.mockRestore();
  });

  // Real `bd show <id> --json` returns an ARRAY — the requested bead, then any
  // dependencies. The old mock returned a bare object, which hid that findBeadLog
  // could never parse a real payload (8ym).
  const BEAD = {
    id: 'bd-99', title: 'Special task', status: 'closed',
    notes: 'Round 1: dispatching Silpi\nRound 1: APPROVE',
  };
  const DEP = { id: 'bd-7', title: 'Blocking dependency', status: 'closed', notes: 'Round 1: REJECT' };

  it.each([
    ['the real array shape', [BEAD]],
    ['an array with a dependency after the bead', [BEAD, DEP]],
    ['an array listing the bead after another row', [DEP, BEAD]],
  ])('finds a bead by id across kshetras when --bead is set — %s', async (_shape, payload) => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockBdShow.mockResolvedValue(JSON.stringify(payload));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ beadId: 'bd-99', all: false });
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Kshetra: Myapp (myapp)');
    expect(output).toContain('[closed] bd-99 · Special task');
    expect(output).toContain('APPROVE');
    expect(output).not.toContain('Blocking dependency');
    logSpy.mockRestore();
  });

  it('resolves a short id to the canonical bead bd echoes back', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockBdShow.mockResolvedValue(JSON.stringify([{ ...BEAD, id: 'myapp-beads-99' }, DEP]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ beadId: '99', all: false });
    expect(mockBdShow).toHaveBeenCalledWith('99');
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('[closed] myapp-beads-99 · Special task');
    expect(output).not.toContain('Blocking dependency');
    logSpy.mockRestore();
  });

  it('keeps searching later kshetras when bd show misses in the first', async () => {
    const K2 = { ...KSHETRA, id: 'beta', name: 'Beta' };
    mockLoadRegistry.mockReturnValue([KSHETRA, K2]);
    mockBdShow
      .mockRejectedValueOnce(new Error('no issue found matching "bd-99"'))
      .mockResolvedValueOnce(JSON.stringify([BEAD]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ beadId: 'bd-99', all: false });
    expect(mockBdShow).toHaveBeenCalledTimes(2);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Kshetra: Beta (beta)');
    expect(output).toContain('[closed] bd-99 · Special task');
    logSpy.mockRestore();
  });

  it('--kshetra scopes the --bead lookup to that kshetra', async () => {
    const K2 = { ...KSHETRA, id: 'beta', name: 'Beta' };
    mockLoadRegistry.mockReturnValue([KSHETRA, K2]);
    // Both kshetras would resolve the id (a short id can exist in more than one).
    mockBdShow.mockResolvedValue(JSON.stringify([BEAD]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ kshetraId: 'beta', beadId: 'bd-99', all: false });
    expect(mockBd).toHaveBeenCalledTimes(1);
    expect(mockBd).toHaveBeenCalledWith(K2);
    expect(logSpy.mock.calls.map(c => c[0]).join('\n')).toContain('Kshetra: Beta (beta)');
    logSpy.mockRestore();
  });

  it('exits with error when --bead is scoped to an unregistered --kshetra', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runLogs({ kshetraId: 'ghost', beadId: 'bd-99', all: false })).rejects.toThrow('exit');
    expect(errSpy).toHaveBeenCalledWith('Kshetra not found: ghost');
    expect(mockBdShow).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it.each([
    ['an empty array', '[]'],
    ['a bare object (never bd show\'s shape)', JSON.stringify(BEAD)],
  ])('exits with error when bd show returns %s', async (_shape, payload) => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockBdShow.mockResolvedValue(payload);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runLogs({ beadId: 'bd-99', all: false })).rejects.toThrow('exit');
    expect(errSpy).toHaveBeenCalledWith('Bead not found: bd-99');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits with error when --bead id not found in any kshetra', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockBdShow.mockRejectedValue(new Error('not found'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runLogs({ beadId: 'bd-nope', all: false })).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});