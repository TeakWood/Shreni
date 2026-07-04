import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadPhalakaPid = vi.fn<() => number | null>();
const mockWritePhalakaPid = vi.fn();
const mockClearPhalakaPid = vi.fn();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockReadToken = vi.fn<() => string | null>();
const mockEnsureToken = vi.fn<() => string>();
const mockSpawn = vi.fn();
const mockOpenSync = vi.fn().mockReturnValue(99);
const mockMkdirSync = vi.fn();

vi.mock('../phalaka/pid', () => ({
  readPhalakaPid: mockReadPhalakaPid,
  writePhalakaPid: mockWritePhalakaPid,
  clearPhalakaPid: mockClearPhalakaPid,
  isAlive: mockIsAlive,
  PHALAKA_PID_PATH: '/tmp/phalaka.pid',
}));

vi.mock('../phalaka/token', () => ({
  readToken: mockReadToken,
  ensureToken: mockEnsureToken,
  TOKEN_PATH: '/tmp/shreni.token',
}));

vi.mock('child_process', () => ({ spawn: mockSpawn }));

vi.mock('fs', () => ({ openSync: mockOpenSync, mkdirSync: mockMkdirSync }));

vi.mock('../phalaka/server', () => ({ DEFAULT_PORT: 7348 }));

const { startPhalaka, stopPhalaka, statusPhalaka } = await import('./phalaka');

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureToken.mockReturnValue('test-token-abc');
  mockReadToken.mockReturnValue('test-token-abc');
  mockSpawn.mockReturnValue({ pid: 9999, unref: vi.fn() });
  mockOpenSync.mockReturnValue(99);
});

describe('startPhalaka', () => {
  it('returns already_running when process is alive', () => {
    mockReadPhalakaPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startPhalaka(7348, '/fake/phalaka-server.js');
    expect(result.status).toBe('already_running');
    expect(result.pid).toBe(1234);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns a detached process when not running', () => {
    mockReadPhalakaPid.mockReturnValue(null);

    const result = startPhalaka(7348, '/fake/phalaka-server.js');
    expect(result.status).toBe('started');
    expect(result.pid).toBe(9999);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/fake/phalaka-server.js'],
      expect.objectContaining({ detached: true }),
    );
  });

  it('includes the shared token and loopback host in the dashboard URL', () => {
    mockReadPhalakaPid.mockReturnValue(null);

    const result = startPhalaka(7348, '/fake/phalaka-server.js');
    expect(result.url).toContain('token=test-token-abc');
    expect(result.url).toContain('127.0.0.1:7348');
  });

  it('spawns with PHALAKA_PORT env var', () => {
    mockReadPhalakaPid.mockReturnValue(null);

    startPhalaka(8080, '/fake/phalaka-server.js');
    const spawnCall = mockSpawn.mock.calls[0]!;
    expect(spawnCall[2].env.PHALAKA_PORT).toBe('8080');
  });

  it('throws when spawn returns no pid', () => {
    mockReadPhalakaPid.mockReturnValue(null);
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startPhalaka(7348, '/fake/phalaka-server.js')).toThrow('Failed to spawn');
  });
});

describe('stopPhalaka', () => {
  it('returns not_running when no pid file', () => {
    mockReadPhalakaPid.mockReturnValue(null);

    const result = stopPhalaka();
    expect(result.status).toBe('not_running');
  });

  it('clears stale PID when process is dead', () => {
    mockReadPhalakaPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(false);

    const result = stopPhalaka();
    expect(result.status).toBe('stale_pid_cleared');
    expect(mockClearPhalakaPid).toHaveBeenCalled();
  });

  it('sends SIGTERM and clears PID for a running process', () => {
    mockReadPhalakaPid.mockReturnValue(5678);
    mockIsAlive.mockReturnValue(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const result = stopPhalaka();

    expect(result.status).toBe('stopped');
    expect((result as { status: 'stopped'; pid: number }).pid).toBe(5678);
    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(mockClearPhalakaPid).toHaveBeenCalled();

    killSpy.mockRestore();
  });
});

describe('statusPhalaka', () => {
  it('returns not running when no pid file', () => {
    mockReadPhalakaPid.mockReturnValue(null);

    const result = statusPhalaka();
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.url).toBeNull();
  });

  it('returns running with dashboard URL when process is alive', () => {
    mockReadPhalakaPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = statusPhalaka(7348);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(1234);
    expect(result.url).toContain('token=test-token-abc');
  });

  it('returns not running when pid exists but process dead', () => {
    mockReadPhalakaPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(false);

    const result = statusPhalaka();
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
  });
});