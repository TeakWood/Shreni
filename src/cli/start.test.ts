import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadPid = vi.fn<(id: string) => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
const mockClaim = vi.fn<(id: string, pid: number) => { ok: true } | { ok: false; ownerPid: number }>(() => ({ ok: true }));

vi.mock('./pid', () => ({
  readPid: mockReadPid,
  isLiveWorker: mockIsAlive,
  claimWorkerPid: mockClaim,
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
  mockClaim.mockReturnValue({ ok: true });
});

describe('startWorker', () => {
  it('returns already_running when process with existing PID is alive', () => {
    mockReadPid.mockReturnValue(1234);
    mockIsAlive.mockReturnValue(true);

    const result = startWorker('myapp', {}, false, { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'already_running', kshetraId: 'myapp', pid: 1234 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns worker and writes PID when no existing process', () => {
    mockReadPid.mockReturnValue(null);
    mockIsAlive.mockReturnValue(false);
    const child = makeChild(5678);
    mockSpawn.mockReturnValue(child);

    const result = startWorker('myapp', {}, false, { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'started', kshetraId: 'myapp', pid: 5678 });
    expect(mockClaim).toHaveBeenCalledWith('myapp', 5678);
    expect(child.unref).toHaveBeenCalled();
  });

  it('spawns worker when PID file exists but process is dead (stale)', () => {
    mockReadPid.mockReturnValue(9999);
    mockIsAlive.mockReturnValue(false);
    const child = makeChild(1001);
    mockSpawn.mockReturnValue(child);

    const result = startWorker('myapp', {}, false, { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'started', kshetraId: 'myapp', pid: 1001 });
  });

  it('spawns with the kshetra id as argv, detached:true and log file stdio', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue(makeChild(42));

    startWorker('myapp', {}, false, { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      ['/path/to/worker.js', 'myapp'],
      expect.objectContaining({ detached: true, stdio: ['ignore', 3, 3] }),
    );
  });

  // Shreni-beads-4w0: a worker that claimed the kshetra between the liveness check
  // and the spawn wins; start backs out instead of overwriting its identity.
  it('kills its child and reports already_running when another worker wins the claim race', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue(makeChild(4321));
    mockClaim.mockReturnValue({ ok: false, ownerPid: 777 });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = startWorker('myapp', {}, false, { command: 'node', args: ['/path/to/worker.js', 'myapp'] });

    expect(result).toEqual({ status: 'already_running', kshetraId: 'myapp', pid: 777 });
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM');
    kill.mockRestore();
  });

  it('throws when spawn returns no pid', () => {
    mockReadPid.mockReturnValue(null);
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startWorker('myapp', {}, false, { command: 'node', args: ['/path/to/worker.js', 'myapp'] })).toThrow('Failed to spawn worker process for "myapp"');
  });
});
