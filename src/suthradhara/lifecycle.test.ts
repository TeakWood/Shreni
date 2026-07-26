import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

const mockReadPid = vi.fn<(id: string) => number | null>();
const mockWritePid = vi.fn();
const mockClearPid = vi.fn();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockSpawn = vi.fn();
const mockOpenSync = vi.fn().mockReturnValue(42);
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn<(p: string) => boolean>();

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
}));

vi.mock('child_process', () => ({ spawn: mockSpawn }));

vi.mock('fs', () => ({
  openSync: mockOpenSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
}));

const { startSession, stopSession, statusSession } = await import('./lifecycle');

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  agents: { provider: 'anthropic', model: 'claude-opus-4-7', maxRoundsPerBead: 3 },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockReadPid.mockReturnValue(null);
  mockIsAlive.mockReturnValue(false);
  mockExistsSync.mockReturnValue(true);
  mockSpawn.mockReturnValue({ pid: 7777, unref: vi.fn() });
});

describe('startSession', () => {
  it('returns already_running when the PID is live (idempotent)', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startSession(KSHETRA, { command: 'node', args: ['runner.js', 'myapp'] });
    expect(result.status).toBe('already_running');
    expect(result.pid).toBe(1234);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns a detached process bound to the Kshetra repo cwd', () => {
    const result = startSession(KSHETRA, { command: 'node', args: ['runner.js', 'myapp'] });
    expect(result.status).toBe('started');
    expect(result.pid).toBe(7777);

    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe('node');
    expect(args).toEqual(['runner.js', 'myapp']);
    expect(opts).toMatchObject({ detached: true, cwd: '/projects/myapp' });
  });

  it('writes the PID once the child spawns', () => {
    startSession(KSHETRA, { command: 'node', args: ['runner.js', 'myapp'] });
    expect(mockWritePid).toHaveBeenCalledWith('myapp', 7777);
  });

  it('refuses to spawn when the Kshetra repo path is missing', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => startSession(KSHETRA, { command: 'node', args: [] })).toThrow(
      /repo path does not exist/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('throws when spawn returns no pid', () => {
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });
    expect(() => startSession(KSHETRA, { command: 'node', args: [] })).toThrow(/Failed to spawn/);
  });

  it('replaces a stale PID file with a fresh session', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(false);

    const result = startSession(KSHETRA, { command: 'node', args: [] });
    expect(result.status).toBe('started');
    expect(mockSpawn).toHaveBeenCalled();
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
