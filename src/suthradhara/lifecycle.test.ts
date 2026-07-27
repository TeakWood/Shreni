import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import type { SessionState } from './state';

const mockReadPid = vi.fn<(id: string) => number | null>();
const mockWritePid = vi.fn();
const mockClearPid = vi.fn();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockSpawn = vi.fn();
const mockOpenSync = vi.fn().mockReturnValue(42);
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn<(p: string) => boolean>();
const mockSaveSession = vi.fn();
const mockLoadSession = vi.fn<(id: string) => SessionState>();
const mockGenerateSessionId = vi.fn<(id: string) => string>();

vi.mock('./pid', () => ({
  readSuthradharaPid: mockReadPid,
  writeSuthradharaPid: mockWritePid,
  clearSuthradharaPid: mockClearPid,
  isAlive: mockIsAlive,
  suthradharaLogPath: (id: string) => `/tmp/${id}/suthradhara.log`,
  suthradharaPidPath: (id: string) => `/tmp/${id}/suthradhara.pid`,
}));

vi.mock('../cli/pid', () => ({
  kshetraDir: (id: string) => `/tmp/${id}`,
  shreniDir: () => '/tmp',
}));

vi.mock('child_process', () => ({ spawn: mockSpawn }));

vi.mock('fs', () => ({
  openSync: mockOpenSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
}));

class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Suthradhara session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

vi.mock('./persistence', () => ({
  generateSessionId: mockGenerateSessionId,
  saveSession: mockSaveSession,
  loadSession: mockLoadSession,
  SessionNotFoundError,
}));

const { startSession, resumeSession, stopSession, statusSession } = await import('./lifecycle');

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  agents: { provider: 'anthropic', model: 'claude-opus-4-7', maxRoundsPerBead: 3 },
} as unknown as KshetraConfig;

const SESSION_ID = 'myapp-20260727T140312-a3f2';

function fakeLaunch(sessionId: string) {
  return { command: 'node', args: ['runner.js', 'myapp', sessionId] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadPid.mockReturnValue(null);
  mockIsAlive.mockReturnValue(false);
  mockExistsSync.mockReturnValue(true);
  mockSpawn.mockReturnValue({ pid: 7777, unref: vi.fn() });
  mockGenerateSessionId.mockReturnValue(SESSION_ID);
});

describe('startSession', () => {
  it('returns already_running when the PID is live (idempotent)', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startSession(KSHETRA, fakeLaunch);
    expect(result.status).toBe('already_running');
    if (result.status === 'already_running') {
      expect(result.pid).toBe(1234);
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('mints a session id, persists the initial state, and threads the id into the child argv', () => {
    const result = startSession(KSHETRA, fakeLaunch);
    expect(result.status).toBe('started');
    if (result.status === 'started') {
      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.pid).toBe(7777);
    }
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    const savedState = mockSaveSession.mock.calls[0][0] as SessionState;
    expect(savedState.id).toBe(SESSION_ID);
    expect(savedState.kshetraId).toBe('myapp');
    expect(savedState.stage).toBe('discovery');

    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe('node');
    expect(args).toEqual(['runner.js', 'myapp', SESSION_ID]);
    expect(opts).toMatchObject({ detached: true, cwd: '/projects/myapp' });
  });

  it('writes the PID once the child spawns', () => {
    startSession(KSHETRA, fakeLaunch);
    expect(mockWritePid).toHaveBeenCalledWith('myapp', 7777);
  });

  it('refuses to spawn when the Kshetra repo path is missing', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => startSession(KSHETRA, fakeLaunch)).toThrow(/repo path does not exist/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('throws when spawn returns no pid', () => {
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });
    expect(() => startSession(KSHETRA, fakeLaunch)).toThrow(/Failed to spawn/);
  });

  it('replaces a stale PID file with a fresh session', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(false);

    const result = startSession(KSHETRA, fakeLaunch);
    expect(result.status).toBe('started');
    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe('resumeSession', () => {
  const state: SessionState = {
    version: 1,
    id: SESSION_ID,
    kshetraId: 'myapp',
    createdAt: '2026-07-27T14:03:12.000Z',
    updatedAt: '2026-07-27T14:10:00.000Z',
    stage: 'clarify',
    rubric: {
      intent: true,
      usersStories: false,
      successCriteria: false,
      scopeBoundary: false,
      nonFunctional: false,
      dependenciesUnknowns: false,
    },
    requirements: ['pause survives worker restart'],
    openQuestions: [],
    transcript: [],
  };

  it('spawns the runner with the existing session id and does NOT overwrite state', () => {
    mockLoadSession.mockReturnValue(state);

    const result = resumeSession(KSHETRA, SESSION_ID, fakeLaunch);
    expect(result.status).toBe('resumed');
    if (result.status === 'resumed') {
      expect(result.sessionId).toBe(SESSION_ID);
    }
    expect(mockSaveSession).not.toHaveBeenCalled();

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(['runner.js', 'myapp', SESSION_ID]);
  });

  it('returns already_running without re-spawning when a live session exists', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = resumeSession(KSHETRA, SESSION_ID, fakeLaunch);
    expect(result.status).toBe('already_running');
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects a session that belongs to a different kshetra', () => {
    mockLoadSession.mockReturnValue({ ...state, kshetraId: 'other' });

    expect(() => resumeSession(KSHETRA, SESSION_ID, fakeLaunch)).toThrow(
      /belongs to kshetra "other"/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rewrites a SessionNotFoundError as a helpful CLI-facing message', () => {
    mockLoadSession.mockImplementation(() => {
      throw new SessionNotFoundError(SESSION_ID);
    });

    expect(() => resumeSession(KSHETRA, SESSION_ID, fakeLaunch)).toThrow(
      /Cannot resume: session .* not found/,
    );
  });

  it('refuses to spawn when the Kshetra repo path is missing', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => resumeSession(KSHETRA, SESSION_ID, fakeLaunch)).toThrow(
      /repo path does not exist/,
    );
  });
});

describe('stopSession', () => {
  it('reports not_running when no PID file exists', () => {
    mockReadPid.mockReturnValue(null);
    expect(stopSession('myapp').status).toBe('not_running');
  });

  it('clears a stale PID file when the process is dead', () => {
    mockReadPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(false);
    const result = stopSession('myapp');
    expect(result.status).toBe('stale_pid_cleared');
    expect(mockClearPid).toHaveBeenCalledWith('myapp');
  });

  it('SIGTERMs a live process and clears the PID file', () => {
    mockReadPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = stopSession('myapp');
    expect(result.status).toBe('stopped');
    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(mockClearPid).toHaveBeenCalledWith('myapp');

    killSpy.mockRestore();
  });
});

describe('statusSession', () => {
  it('reports not running when no PID file exists', () => {
    mockReadPid.mockReturnValue(null);
    const result = statusSession('myapp');
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
  });

  it('reports running with the PID when the process is alive', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);
    const result = statusSession('myapp');
    expect(result.running).toBe(true);
    expect(result.pid).toBe(1234);
  });

  it('reports not running when the PID file is stale', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(false);
    const result = statusSession('myapp');
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
  });

  it('exposes the log path for the operator to tail', () => {
    const result = statusSession('myapp');
    expect(result.logPath).toBe('/tmp/myapp/suthradhara.log');
  });
});
