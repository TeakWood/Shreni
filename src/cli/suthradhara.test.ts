import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

const mockStartSession = vi.fn();
const mockStopSession = vi.fn();
const mockStatusSession = vi.fn();
const mockResumeSession = vi.fn();
const mockListSessions = vi.fn();

vi.mock('../suthradhara/lifecycle', () => ({
  startSession: mockStartSession,
  stopSession: mockStopSession,
  statusSession: mockStatusSession,
  resumeSession: mockResumeSession,
}));

vi.mock('../suthradhara/persistence', () => ({
  listSessions: mockListSessions,
}));

vi.mock('../kshetra/registry', () => ({
  loadRegistry: vi.fn(() => []),
}));

const {
  parseAtMention,
  parseSessionId,
  kshetraIdFromSessionId,
  resolveTargetKshetra,
  runSuthradhara,
} = await import('./suthradhara');

const KSHETRA_A = {
  id: 'alpha',
  repo: { path: '/projects/alpha', remote: '', mainBranch: 'main', branchPattern: '' },
} as unknown as KshetraConfig;

const KSHETRA_B = {
  id: 'beta',
  repo: { path: '/projects/beta', remote: '', mainBranch: 'main', branchPattern: '' },
} as unknown as KshetraConfig;

const ALPHA_SESSION = 'alpha-20260727T140312-a3f2';
const BETA_SESSION = 'beta-20260727T140312-b1c8';

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

describe('parseSessionId', () => {
  it('picks a well-formed session id out of the argv', () => {
    expect(parseSessionId(['resume', ALPHA_SESSION])).toBe(ALPHA_SESSION);
  });

  it('ignores non-matching tokens', () => {
    expect(parseSessionId(['@alpha', '--foo', 'bar'])).toBeUndefined();
  });
});

describe('kshetraIdFromSessionId', () => {
  it('strips the timestamp+hex suffix, leaving just the kshetra id', () => {
    expect(kshetraIdFromSessionId(ALPHA_SESSION)).toBe('alpha');
    expect(kshetraIdFromSessionId(BETA_SESSION)).toBe('beta');
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

  it('start dispatches to startSession with the resolved kshetra and prints the session id', () => {
    mockStartSession.mockReturnValue({
      status: 'started', kshetraId: 'alpha', sessionId: ALPHA_SESSION, pid: 100,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('start', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(mockStartSession).toHaveBeenCalledWith(KSHETRA_A);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('started (pid 100)');
    expect(output).toContain(`Session: ${ALPHA_SESSION}`);
    expect(output).toContain(`resume ${ALPHA_SESSION}`);
    logSpy.mockRestore();
  });

  it('start reports already_running without spawning again', () => {
    mockStartSession.mockReturnValue({ status: 'already_running', kshetraId: 'alpha', pid: 100 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('start', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
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

  it('resume infers the kshetra from the session id and dispatches to resumeSession', () => {
    mockResumeSession.mockReturnValue({
      status: 'resumed', kshetraId: 'alpha', sessionId: ALPHA_SESSION, pid: 200,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('resume', {
      args: [ALPHA_SESSION], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(mockResumeSession).toHaveBeenCalledWith(KSHETRA_A, ALPHA_SESSION);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('resumed (pid 200)');
    expect(output).toContain(`Session: ${ALPHA_SESSION}`);
    logSpy.mockRestore();
  });

  it('resume reports already_running when a live session exists', () => {
    mockResumeSession.mockReturnValue({ status: 'already_running', kshetraId: 'alpha', pid: 100 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('resume', {
      args: [ALPHA_SESSION], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running (pid 100)'));
    logSpy.mockRestore();
  });

  it('resume rejects a missing session id argument', () => {
    expect(() =>
      runSuthradhara('resume', {
        args: [], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
      }),
    ).toThrow(/Usage: shreni suthradhara resume/);
  });

  it('resume rejects a session id whose kshetra is not registered', () => {
    expect(() =>
      runSuthradhara('resume', {
        args: [BETA_SESSION], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A],
      }),
    ).toThrow(/kshetra "beta", which is not registered/);
  });

  it('list prints every session across kshetras when no filter is given', () => {
    mockListSessions.mockReturnValue([
      { id: BETA_SESSION, kshetraId: 'beta', stage: 'clarify', updatedAt: '2026-07-27T14:10:00.000Z' },
      { id: ALPHA_SESSION, kshetraId: 'alpha', stage: 'discovery', updatedAt: '2026-07-27T14:03:12.000Z' },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('list', {
      args: [], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A, KSHETRA_B],
    });
    expect(mockListSessions).toHaveBeenCalledWith(undefined);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain(ALPHA_SESSION);
    expect(output).toContain(BETA_SESSION);
    logSpy.mockRestore();
  });

  it('list filters by kshetra when @<id> is present', () => {
    mockListSessions.mockReturnValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runSuthradhara('list', {
      args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A, KSHETRA_B],
    });
    expect(mockListSessions).toHaveBeenCalledWith('alpha');
    expect(logSpy).toHaveBeenCalledWith('No suthradhara sessions for alpha.');
    logSpy.mockRestore();
  });
});
