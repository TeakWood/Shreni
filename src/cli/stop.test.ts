import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadPid = vi.fn<() => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockClearPid = vi.fn<() => void>();

vi.mock('./pid', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
  clearPid: mockClearPid,
  writePid: vi.fn(),
  PID_PATH: '/tmp/shreni.pid',
}));

const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

const { stopDaemon } = await import('./stop');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stopDaemon', () => {
  it('returns not_running when no PID file', () => {
    mockReadPid.mockReturnValue(null);

    const result = stopDaemon();

    expect(result).toEqual({ status: 'not_running' });
    expect(mockKill).not.toHaveBeenCalled();
    expect(mockClearPid).not.toHaveBeenCalled();
  });

  it('returns stale_pid_cleared when PID file exists but process is dead', () => {
    mockReadPid.mockReturnValue(9999);
    mockIsAlive.mockReturnValue(false);

    const result = stopDaemon();

    expect(result).toEqual({ status: 'stale_pid_cleared' });
    expect(mockClearPid).toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and clears PID file when process is alive', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = stopDaemon();

    expect(result).toEqual({ status: 'stopped', pid: 1234 });
    expect(mockKill).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(mockClearPid).toHaveBeenCalled();
  });
});