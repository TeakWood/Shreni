import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadPid = vi.fn<() => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockWritePid = vi.fn<(pid: number) => void>();

vi.mock('./pid', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
  writePid: mockWritePid,
  clearPid: vi.fn(),
  PID_PATH: '/tmp/shreni.pid',
}));

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({ spawn: mockSpawn }));

const { startDaemon } = await import('./start');

function makeChild(pid: number) {
  return { pid, unref: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startDaemon', () => {
  it('returns already_running when process with existing PID is alive', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startDaemon('/path/to/daemon.js');

    expect(result).toEqual({ status: 'already_running', pid: 1234 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns daemon and writes PID when no existing process', () => {
    mockReadPid.mockReturnValue(null);
    mockIsAlive.mockReturnValue(false);
    const child = makeChild(5678);
    mockSpawn.mockReturnValue(child);

    const result = startDaemon('/path/to/daemon.js');

    expect(result).toEqual({ status: 'started', pid: 5678 });
    expect(mockWritePid).toHaveBeenCalledWith(5678);
    expect(child.unref).toHaveBeenCalled();
  });

  it('spawns daemon when PID file exists but process is dead (stale)', () => {
    mockReadPid.mockReturnValue(9999);
    mockIsAlive.mockReturnValue(false);
    const child = makeChild(1001);
    mockSpawn.mockReturnValue(child);

    const result = startDaemon('/path/to/daemon.js');

    expect(result).toEqual({ status: 'started', pid: 1001 });
  });

  it('spawns with detached:true and stdio:ignore', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue(makeChild(42));

    startDaemon('/path/to/daemon.js');

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/path/to/daemon.js'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('throws when spawn returns no pid', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startDaemon('/path/to/daemon.js')).toThrow('Failed to spawn daemon process');
  });
});