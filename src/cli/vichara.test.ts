import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadVicharaPid = vi.fn<() => number | null>();
const mockWriteVicharaPid = vi.fn();
const mockClearVicharaPid = vi.fn();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockReadToken = vi.fn<() => string | null>();
const mockEnsureToken = vi.fn<() => string>();
const mockSpawn = vi.fn();
const mockOpenSync = vi.fn().mockReturnValue(99);
const mockMkdirSync = vi.fn();

vi.mock('../vichara/pid', () => ({
  readVicharaPid: mockReadVicharaPid,
  writeVicharaPid: mockWriteVicharaPid,
  clearVicharaPid: mockClearVicharaPid,
  isAlive: mockIsAlive,
  VICHARA_PID_PATH: '/tmp/vichara.pid',
}));

vi.mock('../vichara/token', () => ({
  readToken: mockReadToken,
  ensureToken: mockEnsureToken,
  TOKEN_PATH: '/tmp/vichara.token',
}));

vi.mock('child_process', () => ({ spawn: mockSpawn }));

vi.mock('fs', () => ({ openSync: mockOpenSync, mkdirSync: mockMkdirSync }));

vi.mock('../vichara/server', () => ({ DEFAULT_PORT: 7347 }));

const { startVichara, stopVichara, statusVichara } = await import('./vichara');

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureToken.mockReturnValue('test-token-abc');
  mockReadToken.mockReturnValue('test-token-abc');
  mockSpawn.mockReturnValue({ pid: 9999, unref: vi.fn() });
  mockOpenSync.mockReturnValue(99);
});

describe('startVichara', () => {
  it('returns already_running when process is alive', () => {
    mockReadVicharaPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startVichara(7347, '/fake/vichara-server.js');
    expect(result.status).toBe('already_running');
    expect(result.pid).toBe(1234);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns a new process when not running', () => {
    mockReadVicharaPid.mockReturnValue(null);

    const result = startVichara(7347, '/fake/vichara-server.js');
    expect(result.status).toBe('started');
    expect(result.pid).toBe(9999);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/fake/vichara-server.js'],
      expect.objectContaining({ detached: true }),
    );
  });

  it('includes token in URL', () => {
    mockReadVicharaPid.mockReturnValue(null);

    const result = startVichara(7347, '/fake/vichara-server.js');
    expect(result.url).toContain('token=test-token-abc');
    expect(result.url).toContain('127.0.0.1:7347');
  });

  it('spawns with VICHARA_PORT env var', () => {
    mockReadVicharaPid.mockReturnValue(null);

    startVichara(8080, '/fake/vichara-server.js');
    const spawnCall = mockSpawn.mock.calls[0]!;
    expect(spawnCall[2].env.VICHARA_PORT).toBe('8080');
  });

  it('throws when spawn returns no pid', () => {
    mockReadVicharaPid.mockReturnValue(null);
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startVichara(7347, '/fake/vichara-server.js')).toThrow('Failed to spawn');
  });
});

describe('stopVichara', () => {
  it('returns not_running when no pid file', () => {
    mockReadVicharaPid.mockReturnValue(null);

    const result = stopVichara();
    expect(result.status).toBe('not_running');
  });

  it('clears stale PID when process is dead', () => {
    mockReadVicharaPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(false);

    const result = stopVichara();
    expect(result.status).toBe('stale_pid_cleared');
    expect(mockClearVicharaPid).toHaveBeenCalled();
  });

  it('sends SIGTERM and clears PID for running process', () => {
    mockReadVicharaPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const result = stopVichara();

    expect(result.status).toBe('stopped');
    expect((result as { status: 'stopped'; pid: number }).pid).toBe(5678);
    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(mockClearVicharaPid).toHaveBeenCalled();

    killSpy.mockRestore();
  });
});

describe('statusVichara', () => {
  it('returns not running when no pid file', () => {
    mockReadVicharaPid.mockReturnValue(null);

    const result = statusVichara();
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.url).toBeNull();
  });

  it('returns running with URL when process is alive', () => {
    mockReadVicharaPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = statusVichara(7347);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(1234);
    expect(result.url).toContain('token=test-token-abc');
  });

  it('returns not running when pid exists but process dead', () => {
    mockReadVicharaPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(false);

    const result = statusVichara();
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
  });
});