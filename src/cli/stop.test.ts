import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadPid = vi.fn<(id: string) => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockClearPid = vi.fn<(id: string) => void>();

vi.mock('./pid', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
  clearPid: mockClearPid,
  writePid: vi.fn(),
}));

const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

const { stopWorker } = await import('./stop');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stopWorker', () => {
  it('returns not_running when no PID file', () => {
    mockReadPid.mockReturnValue(null);

    const result = stopWorker('sishya');

    expect(result).toEqual({ status: 'not_running', kshetraId: 'sishya' });
    expect(mockKill).not.toHaveBeenCalled();
    expect(mockClearPid).not.toHaveBeenCalled();
  });

  it('returns stale_pid_cleared when PID file exists but process is dead', () => {
    mockReadPid.mockReturnValue(9999);
    mockIsAlive.mockReturnValue(false);

    const result = stopWorker('sishya');

    expect(result).toEqual({ status: 'stale_pid_cleared', kshetraId: 'sishya' });
    expect(mockClearPid).toHaveBeenCalledWith('sishya');
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and clears PID file when process is alive', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = stopWorker('sishya');

    expect(result).toEqual({ status: 'stopped', kshetraId: 'sishya', pid: 1234 });
    expect(mockKill).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(mockClearPid).toHaveBeenCalledWith('sishya');
  });
});
