import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockBdList = vi.fn<(f: { status?: string }) => Promise<string>>();
const mockBdShow = vi.fn<(id: string) => Promise<string>>();
vi.mock('../sthapathi/beads', () => ({
  bd: vi.fn(() => ({ list: mockBdList, show: mockBdShow })),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { parseNotesToBeadLog, formatBeadLog, runLogs } = await import('./logs');

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
    await runLogs({ kshetraId: 'sishya', all: false });
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
    expect(output).toContain('Sishya');
    expect(output).toContain('Beta');
    logSpy.mockRestore();
  });

  it('finds a bead by id across kshetras when --bead is set', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA]);
    mockBdShow.mockResolvedValue(JSON.stringify({
      id: 'bd-99', title: 'Special task', status: 'closed',
      notes: 'Round 1: dispatching Silpi\nRound 1: APPROVE',
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runLogs({ beadId: 'bd-99', all: false });
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('bd-99');
    expect(output).toContain('APPROVE');
    logSpy.mockRestore();
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