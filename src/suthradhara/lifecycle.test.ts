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

const mockCreateWorktree = vi.fn<(k: unknown, sid: string) => Promise<string>>();
const mockReapWorktrees = vi.fn<(k: unknown) => Promise<string[]>>();

vi.mock('./worktree', () => ({
  createSessionWorktree: (k: unknown, sid: string) => mockCreateWorktree(k, sid),
  reapSessionWorktrees: (k: unknown) => mockReapWorktrees(k),
}));

const WORKTREE_PATH = `/tmp/worktrees/myapp/suthradhara-${'myapp-20260727T140312-a3f2'}`;

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
  mockCreateWorktree.mockResolvedValue(WORKTREE_PATH);
  mockReapWorktrees.mockResolvedValue([]);
});

describe('startSession', () => {
  it('returns already_running when the PID is live (idempotent)', async () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = await startSession(KSHETRA, fakeLaunch);
    expect(result.status).toBe('already_running');
    if (result.status === 'already_running') {
      expect(result.pid).toBe(1234);
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
    // A live session is untouched — no worktree churn.
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('mints a session id, persists the initial state, and threads the id into the child argv', async () => {
    const result = await startSession(KSHETRA, fakeLaunch);
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
    // cwd is the session worktree, not repo.path (ARD §4.2).
    expect(opts).toMatchObject({ detached: true, cwd: WORKTREE_PATH });
  });

  it('reaps leaked worktrees before creating a fresh one for this session', async () => {
    await startSession(KSHETRA, fakeLaunch);
    expect(mockReapWorktrees).toHaveBeenCalledWith(KSHETRA);
    expect(mockCreateWorktree).toHaveBeenCalledWith(KSHETRA, SESSION_ID);
  });

  it('writes the PID once the child spawns', async () => {
    await startSession(KSHETRA, fakeLaunch);
    expect(mockWritePid).toHaveBeenCalledWith('myapp', 7777);
  });

  it('refuses to spawn when the Kshetra repo path is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(startSession(KSHETRA, fakeLaunch)).rejects.toThrow(/repo path does not exist/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('throws when spawn returns no pid', async () => {
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });
    await expect(startSession(KSHETRA, fakeLaunch)).rejects.toThrow(/Failed to spawn/);
  });

  it('replaces a stale PID file with a fresh session', async () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(false);

    const result = await startSession(KSHETRA, fakeLaunch);
    expect(result.status).toBe('started');
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('interactive: spawns attached (stdio inherit, not detached) and returns a wait handle', async () => {
    const handlers: Record<string, (arg: number) => void> = {};
    const child = {
      pid: 8888,
      on: vi.fn((ev: string, cb: (arg: number) => void) => {
        handlers[ev] = cb;
      }),
    };
    mockSpawn.mockReturnValue(child);

    const result = await startSession(KSHETRA, fakeLaunch, true);
    expect(result.status).toBe('started');
    if (result.status !== 'started') return;
    expect(result.pid).toBe(8888);

    const [, , opts] = mockSpawn.mock.calls[0];
    expect(opts).toMatchObject({ stdio: 'inherit', cwd: WORKTREE_PATH });
    expect(opts).not.toHaveProperty('detached');
    expect(mockWritePid).toHaveBeenCalledWith('myapp', 8888);

    // wait() resolves with the exit code once the child exits — and tears down
    // like stopSession (clear PID + reap worktree) since nobody runs `stop`.
    expect(typeof result.wait).toBe('function');
    const reapsBefore = mockReapWorktrees.mock.calls.length;
    const waitP = result.wait!();
    handlers.exit(0);
    await expect(waitP).resolves.toBe(0);
    expect(mockClearPid).toHaveBeenCalledWith('myapp');
    expect(mockReapWorktrees.mock.calls.length).toBe(reapsBefore + 1);
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

  it('spawns the runner with the existing session id and does NOT overwrite state', async () => {
    mockLoadSession.mockReturnValue(state);

    const result = await resumeSession(KSHETRA, SESSION_ID, fakeLaunch);
    expect(result.status).toBe('resumed');
    if (result.status === 'resumed') {
      expect(result.sessionId).toBe(SESSION_ID);
    }
    expect(mockSaveSession).not.toHaveBeenCalled();

    const [, args, opts] = mockSpawn.mock.calls[0];
    expect(args).toEqual(['runner.js', 'myapp', SESSION_ID]);
    // Resume re-establishes the worktree and runs the child there.
    expect(mockCreateWorktree).toHaveBeenCalledWith(KSHETRA, SESSION_ID);
    expect(opts).toMatchObject({ cwd: WORKTREE_PATH });
  });

  it('returns already_running without re-spawning when a live session exists', async () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = await resumeSession(KSHETRA, SESSION_ID, fakeLaunch);
    expect(result.status).toBe('already_running');
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects a session that belongs to a different kshetra', async () => {
    mockLoadSession.mockReturnValue({ ...state, kshetraId: 'other' });

    await expect(resumeSession(KSHETRA, SESSION_ID, fakeLaunch)).rejects.toThrow(
      /belongs to kshetra "other"/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    // A rejected session never creates a worktree.
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('rewrites a SessionNotFoundError as a helpful CLI-facing message', async () => {
    mockLoadSession.mockImplementation(() => {
      throw new SessionNotFoundError(SESSION_ID);
    });

    await expect(resumeSession(KSHETRA, SESSION_ID, fakeLaunch)).rejects.toThrow(
      /Cannot resume: session .* not found/,
    );
  });

  it('refuses to spawn when the Kshetra repo path is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(resumeSession(KSHETRA, SESSION_ID, fakeLaunch)).rejects.toThrow(
      /repo path does not exist/,
    );
  });

  it('interactive: spawns attached and returns a wait handle that tears down on exit', async () => {
    mockLoadSession.mockReturnValue(state);
    const handlers: Record<string, (arg: number) => void> = {};
    const child = {
      pid: 9999,
      on: vi.fn((ev: string, cb: (arg: number) => void) => {
        handlers[ev] = cb;
      }),
    };
    mockSpawn.mockReturnValue(child);

    const result = await resumeSession(KSHETRA, SESSION_ID, fakeLaunch, true);
    expect(result.status).toBe('resumed');
    if (result.status !== 'resumed') return;

    const [, , opts] = mockSpawn.mock.calls[0];
    expect(opts).toMatchObject({ stdio: 'inherit', cwd: WORKTREE_PATH });
    expect(opts).not.toHaveProperty('detached');

    const waitP = result.wait!();
    handlers.exit(0);
    await expect(waitP).resolves.toBe(0);
    expect(mockClearPid).toHaveBeenCalledWith('myapp');
  });
});

describe('stopSession', () => {
  it('reports not_running when no PID file exists, and still sweeps leaked worktrees', async () => {
    mockReadPid.mockReturnValue(null);
    const result = await stopSession(KSHETRA);
    expect(result.status).toBe('not_running');
    expect(mockReapWorktrees).toHaveBeenCalledWith(KSHETRA);
  });

  it('clears a stale PID file when the process is dead', async () => {
    mockReadPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(false);
    const result = await stopSession(KSHETRA);
    expect(result.status).toBe('stale_pid_cleared');
    expect(mockClearPid).toHaveBeenCalledWith('myapp');
    expect(mockReapWorktrees).toHaveBeenCalledWith(KSHETRA);
  });

  it('SIGTERMs a live process, clears the PID file, and tears down the worktree', async () => {
    mockReadPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await stopSession(KSHETRA);
    expect(result.status).toBe('stopped');
    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(mockClearPid).toHaveBeenCalledWith('myapp');
    expect(mockReapWorktrees).toHaveBeenCalledWith(KSHETRA);

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
