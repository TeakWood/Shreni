import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

const mockStartSession = vi.fn();
const mockStopSession = vi.fn();
const mockStatusSession = vi.fn();

vi.mock('../suthradhara/lifecycle', () => ({
  startSession: mockStartSession,
  stopSession: mockStopSession,
  statusSession: mockStatusSession,
}));

vi.mock('../kshetra/registry', () => ({
  loadRegistry: vi.fn(() => []),
}));

const { parseAtMention, resolveTargetKshetra, runSuthradhara } = await import('./suthradhara');

const KSHETRA_A = {
  id: 'alpha',
  repo: { path: '/projects/alpha', remote: '', mainBranch: 'main', branchPattern: '' },
} as unknown as KshetraConfig;

const KSHETRA_B = {
  id: 'beta',
  repo: { path: '/projects/beta', remote: '', mainBranch: 'main', branchPattern: '' },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseAtMention', () => {
  it('extracts the id from @<id>', () => {
    expect(parseAtMention(['@alpha'])).toBe('alpha');
  });

  it('finds the mention at any position in the args', () => {
    expect(parseAtMention(['--foo', 'bar', '@myapp'])).toBe('myapp');
  });

  it('ignores tokens that only start with @ but do not match', () => {
    expect(parseAtMention(['@Uppercase'])).toBeUndefined();
    expect(parseAtMention(['@bad name'])).toBeUndefined();
  });

  it('returns undefined when no mention is present', () => {
    expect(parseAtMention(['start', '--kshetra', 'foo'])).toBeUndefined();
  });
});

describe('resolveTargetKshetra', () => {
  it('resolves via @<id> mention', () => {
    const k = resolveTargetKshetra(['@beta'], undefined, '/nowhere', [KSHETRA_A, KSHETRA_B]);
    expect(k.id).toBe('beta');
  });

  it('resolves via --kshetra flag when no mention', () => {
    const k = resolveTargetKshetra([], 'alpha', '/nowhere', [KSHETRA_A, KSHETRA_B]);
    expect(k.id).toBe('alpha');
  });

  it('mention takes precedence over the flag', () => {
    const k = resolveTargetKshetra(['@beta'], 'alpha', '/nowhere', [KSHETRA_A, KSHETRA_B]);
    expect(k.id).toBe('beta');
  });

  it('falls back to cwd resolution when no explicit id', () => {
    const k = resolveTargetKshetra([], undefined, '/projects/beta/src', [KSHETRA_A, KSHETRA_B]);
    expect(k.id).toBe('beta');
  });

  it('throws when an explicit id does not match any registered Kshetra', () => {
    expect(() => resolveTargetKshetra(['@missing'], undefined, '/x', [KSHETRA_A])).toThrow(
      /not found: missing/,
    );
  });

  it('throws with a helpful hint when cwd fallback misses', () => {
    expect(() => resolveTargetKshetra([], undefined, '/elsewhere', [KSHETRA_A])).toThrow(
      /No kshetra resolvable.*Hint:/s,
    );
  });

  it('throws when the registry is empty', () => {
    expect(() => resolveTargetKshetra([], undefined, '/x', [])).toThrow(
      /No kshetras registered/,
    );
  });
});

describe('runSuthradhara', () => {
  it('rejects an unknown subcommand', () => {
    expect(() =>
      runSuthradhara('reboot', { args: [], flagKshetra: undefined, cwd: '/', kshetras: [KSHETRA_A] }),
    ).toThrow(/Usage:/);
  });

  it('rejects a missing subcommand', () => {
    expect(() =>
      runSuthradhara(undefined, { args: [], flagKshetra: undefined, cwd: '/', kshetras: [KSHETRA_A] }),
    ).toThrow(/Usage:/);
  });

  it('start dispatches to startSession with the resolved kshetra', () => {
    mockStartSession.mockReturnValue({ status: 'started', kshetraId: 'alpha', pid: 100 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('start', {
      args: ['@alpha'],
      flagKshetra: undefined,
      cwd: '/x',
      kshetras: [KSHETRA_A],
    });
    expect(mockStartSession).toHaveBeenCalledWith(KSHETRA_A);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('started (pid 100)'));
    logSpy.mockRestore();
  });

  it('start reports already_running without spawning again', () => {
    mockStartSession.mockReturnValue({ status: 'already_running', kshetraId: 'alpha', pid: 100 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('start', {
      args: ['@alpha'],
      flagKshetra: undefined,
      cwd: '/x',
      kshetras: [KSHETRA_A],
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    logSpy.mockRestore();
  });

  it('stop reports stopped / stale / not_running variants', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockStopSession.mockReturnValue({ status: 'stopped', kshetraId: 'alpha', pid: 100 });
    runSuthradhara('stop', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stopped (pid 100)'));

    mockStopSession.mockReturnValue({ status: 'stale_pid_cleared', kshetraId: 'alpha' });
    runSuthradhara('stop', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stale PID file cleared'));

    mockStopSession.mockReturnValue({ status: 'not_running', kshetraId: 'alpha' });
    runSuthradhara('stop', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));

    logSpy.mockRestore();
  });

  it('status reports running + log path', () => {
    mockStatusSession.mockReturnValue({
      kshetraId: 'alpha', running: true, pid: 100, logPath: '/tmp/alpha/suthradhara.log',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('status', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('running (pid 100)');
    expect(output).toContain('/tmp/alpha/suthradhara.log');
    logSpy.mockRestore();
  });

  it('status reports not running when no session', () => {
    mockStatusSession.mockReturnValue({
      kshetraId: 'alpha', running: false, pid: null, logPath: '/tmp/alpha/suthradhara.log',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('status', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    logSpy.mockRestore();
  });
});
