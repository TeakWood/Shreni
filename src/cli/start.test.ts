import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadPid = vi.fn<(id: string) => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockWritePid = vi.fn<(id: string, pid: number) => void>();

vi.mock('./pid', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
  writePid: mockWritePid,
  clearPid: vi.fn(),
  kshetraDir: (id: string) => `/tmp/shreni/kshetra/${id}`,
  workerLogPath: (id: string) => `/tmp/shreni/kshetra/${id}/worker.log`,
}));

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({ spawn: mockSpawn }));

const mockOpenSync = vi.fn().mockReturnValue(3);
const mockMkdirSync = vi.fn();
vi.mock('fs', () => ({ openSync: mockOpenSync, mkdirSync: mockMkdirSync }));

const { startWorker } = await import('./start');

function makeChild(pid: number) {
  return { pid, unref: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startWorker', () => {
  it('returns already_running when process with existing PID is alive', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startWorker('myapp', { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'already_running', kshetraId: 'myapp', pid: 1234 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns worker and writes PID when no existing process', () => {
    mockReadPid.mockReturnValue(null);
    mockIsAlive.mockReturnValue(false);
    const child = makeChild(5678);
    mockSpawn.mockReturnValue(child);

    const result = startWorker('myapp', { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'started', kshetraId: 'myapp', pid: 5678 });
    expect(mockWritePid).toHaveBeenCalledWith('myapp', 5678);
    expect(child.unref).toHaveBeenCalled();
  });

  it('spawns worker when PID file exists but process is dead (stale)', () => {
    mockReadPid.mockReturnValue(9999);
    mockIsAlive.mockReturnValue(false);
    const child = makeChild(1001);
    mockSpawn.mockReturnValue(child);

    const result = startWorker('myapp', { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'started', kshetraId: 'myapp', pid: 1001 });
  });

  it('spawns with the kshetra id as argv, detached:true and log file stdio', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue(makeChild(42));

    startWorker('myapp', { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      ['/path/to/worker.js', 'myapp'],
      expect.objectContaining({ detached: true, stdio: ['ignore', 3, 3] }),
    );
  });

  it('throws when spawn returns no pid', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startWorker('myapp', { command: 'node', args: ['/path/to/worker.js', 'myapp'] })).toThrow('Failed to spawn worker process for "myapp"');
  });
});
