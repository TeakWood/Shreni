import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// ── module mocks ─────────────────────────────────────────────────────────────
// process-read is file-only. Mock every file/liveness source so the enumeration
// and the status derivation can be exercised over fixtures without touching a real
// ~/.shreni. Mock watchdog too so we import only its STUCK_THRESHOLD_MS constant
// without pulling in its state/activity-log dependency graph.
const STUCK_MS = 20 * 60 * 1000;
vi.mock('../sthapathi/watchdog.js', () => ({ STUCK_THRESHOLD_MS: STUCK_MS }));

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry.js', () => ({ loadRegistry: mockLoadRegistry }));

const mockLoadState = vi.fn();
vi.mock('../kshetra/state.js', () => ({ loadState: mockLoadState }));

const mockReadPid = vi.fn<(id: string) => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
vi.mock('../cli/pid.js', () => ({
  readPid: mockReadPid,
  isAlive: mockIsAlive,
  workerPidPath: (id: string) => `PID:${id}`,
}));

vi.mock('../sthapathi/activity-log.js', () => ({
  heartbeatPath: (id: string) => `HB:${id}`,
}));

const mockReadPhalakaPid = vi.fn<() => number | null>();
vi.mock('./pid.js', () => ({ readPhalakaPid: mockReadPhalakaPid }));

const mockReadSuthradharaPid = vi.fn<(id: string) => number | null>();
vi.mock('../suthradhara/pid.js', () => ({ readSuthradharaPid: mockReadSuthradharaPid }));

// statSync backs ageOf(); a path in `mtimes` returns that mtime, anything else
// throws like a missing file.
const mtimes: Record<string, number> = {};
vi.mock('fs', () => ({
  statSync: (path: string) => {
    if (path in mtimes) return { mtimeMs: mtimes[path] };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
}));

const {
  deriveWorkerStatus,
  deriveServiceStatus,
  readProcessSnapshots,
  STALE_HEARTBEAT_MS,
} = await import('./process-read.js');

const STALE_MS = STALE_HEARTBEAT_MS;

function cfg(id: string, watchdog?: { stuckThresholdMs?: number }): KshetraConfig {
  return { id, watchdog } as unknown as KshetraConfig;
}

// Baseline worker signals; each case overrides only what it exercises.
function signals(over: Partial<Parameters<typeof deriveWorkerStatus>[0]> = {}) {
  return {
    pidAlive: true,
    phase: 'WORKING',
    heartbeatAgeMs: 10_000,
    pidAgeMs: 60_000,
    paused: false,
    reason: undefined,
    requiresManualResume: undefined,
    stuck: false,
    ...over,
  };
}

describe('deriveWorkerStatus (ADR §4.3 / §4.4)', () => {
  it('dead — pidfile present but the OS pid is gone (crashed/orphaned)', () => {
    expect(deriveWorkerStatus(signals({ pidAlive: false }))).toBe('dead');
  });

  it('stuck — watchdog marker wins over the manual-pause it co-sets', () => {
    // A watchdog trip sets stuck AND paused+requiresManualResume(reason:'stuck').
    expect(
      deriveWorkerStatus(
        signals({ stuck: true, paused: true, reason: 'stuck', requiresManualResume: true }),
      ),
    ).toBe('stuck');
  });

  it('paused-manual — a deliberate `shreni pause` (reason:manual)', () => {
    expect(deriveWorkerStatus(signals({ paused: true, reason: 'manual' }))).toBe('paused-manual');
  });

  it('paused-manual — requiresManualResume latch even without reason:manual', () => {
    expect(deriveWorkerStatus(signals({ paused: true, requiresManualResume: true }))).toBe(
      'paused-manual',
    );
  });

  it('paused-manual wins over a stale heartbeat — a paused worker stops beating', () => {
    expect(
      deriveWorkerStatus(
        signals({ paused: true, reason: 'manual', heartbeatAgeMs: STUCK_MS + 60_000 }),
      ),
    ).toBe('paused-manual');
  });

  it('working — busy phase with a fresh heartbeat', () => {
    expect(deriveWorkerStatus(signals({ phase: 'WORKING', heartbeatAgeMs: 10_000 }))).toBe(
      'working',
    );
  });

  it('working — freshly started, no heartbeat yet but young pidfile', () => {
    expect(
      deriveWorkerStatus(signals({ heartbeatAgeMs: null, pidAgeMs: 5_000 })),
    ).toBe('working');
  });

  it('stale-heartbeat — busy but silent past the early-warning window, before escalation', () => {
    expect(
      deriveWorkerStatus(signals({ heartbeatAgeMs: STALE_MS + 60_000 })),
    ).toBe('stale-heartbeat');
  });

  it('dead — reused-PID guard: OS pid "alive" but busy & silent past escalation with no stuck marker', () => {
    expect(
      deriveWorkerStatus(signals({ pidAlive: true, stuck: false, heartbeatAgeMs: STUCK_MS + 1 })),
    ).toBe('dead');
  });

  it('dead — never-beat orphan: no heartbeat and an old pidfile', () => {
    expect(
      deriveWorkerStatus(signals({ heartbeatAgeMs: null, pidAgeMs: STUCK_MS + 1 })),
    ).toBe('dead');
  });

  it('honors a per-Kshetra dead ceiling (watchdog.stuckThresholdMs)', () => {
    // With a tighter ceiling the same 5-min silence is already past escalation → dead.
    expect(
      deriveWorkerStatus(signals({ heartbeatAgeMs: 5 * 60_000, thresholds: { deadMs: 3 * 60_000 } })),
    ).toBe('dead');
  });

  it('idle — phase IDLE is idle-by-design, never stuck', () => {
    expect(deriveWorkerStatus(signals({ phase: 'IDLE', heartbeatAgeMs: null }))).toBe('idle');
  });

  it('idle — no phase recorded yet', () => {
    expect(deriveWorkerStatus(signals({ phase: undefined, heartbeatAgeMs: null }))).toBe('idle');
  });

  it('separates idle from stuck on the same "no activity" — the marker is the only difference', () => {
    const quiet = { phase: 'IDLE' as const, heartbeatAgeMs: null };
    expect(deriveWorkerStatus(signals({ ...quiet, stuck: false }))).toBe('idle');
    expect(deriveWorkerStatus(signals({ ...quiet, stuck: true }))).toBe('stuck');
  });
});

describe('deriveServiceStatus', () => {
  it('healthy when alive, dead when the pid is gone', () => {
    expect(deriveServiceStatus(true)).toBe('healthy');
    expect(deriveServiceStatus(false)).toBe('dead');
  });
});

describe('readProcessSnapshots (enumeration)', () => {
  const now = 1_000_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(mtimes)) delete mtimes[k];
    mockLoadRegistry.mockReturnValue([]);
    mockLoadState.mockReturnValue({ kshetras: {} });
    mockReadPid.mockReturnValue(null);
    mockIsAlive.mockReturnValue(false);
    mockReadPhalakaPid.mockReturnValue(null);
    mockReadSuthradharaPid.mockReturnValue(null);
  });

  it('emits a worker row per Kshetra with a pidfile and skips those without', () => {
    mockLoadRegistry.mockReturnValue([cfg('alpha'), cfg('beta')]);
    mockLoadState.mockReturnValue({
      kshetras: { alpha: { phase: 'WORKING', lastProgressAt: '2026-07-30T00:00:00.000Z' } },
    });
    mockReadPid.mockImplementation(id => (id === 'alpha' ? 100 : null));
    mockIsAlive.mockReturnValue(true);
    mtimes['HB:alpha'] = now - 10_000;
    mtimes['PID:alpha'] = now - 60_000;

    const snaps = readProcessSnapshots(now);
    const workers = snaps.filter(s => s.kind === 'worker');
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      kind: 'worker',
      kshetraId: 'alpha',
      pid: 100,
      status: 'working',
      phase: 'WORKING',
      heartbeatAgeMs: 10_000,
      lastProgressAt: '2026-07-30T00:00:00.000Z',
    });
  });

  it('reports a crashed worker (pidfile present, pid dead) as dead', () => {
    mockLoadRegistry.mockReturnValue([cfg('alpha')]);
    mockLoadState.mockReturnValue({ kshetras: { alpha: { phase: 'WORKING' } } });
    mockReadPid.mockReturnValue(100);
    mockIsAlive.mockReturnValue(false);
    mtimes['HB:alpha'] = now - 10_000;

    const [worker] = readProcessSnapshots(now);
    expect(worker.status).toBe('dead');
  });

  it('carries the stuck marker through to the snapshot', () => {
    const stuck = { since: '2026-07-30T00:00:00.000Z', reason: 'hung', remediation: 'resume' };
    mockLoadRegistry.mockReturnValue([cfg('alpha')]);
    mockLoadState.mockReturnValue({ kshetras: { alpha: { phase: 'WORKING', paused: true, stuck } } });
    mockReadPid.mockReturnValue(100);
    mockIsAlive.mockReturnValue(true);

    const [worker] = readProcessSnapshots(now);
    expect(worker.status).toBe('stuck');
    expect(worker.stuck).toEqual(stuck);
    expect(worker.paused).toBe(true);
  });

  it('applies the per-Kshetra watchdog threshold as the dead ceiling', () => {
    mockLoadRegistry.mockReturnValue([cfg('alpha', { stuckThresholdMs: 3 * 60_000 })]);
    mockLoadState.mockReturnValue({ kshetras: { alpha: { phase: 'WORKING' } } });
    mockReadPid.mockReturnValue(100);
    mockIsAlive.mockReturnValue(true);
    mtimes['HB:alpha'] = now - 5 * 60_000; // past the 3-min ceiling → dead

    const [worker] = readProcessSnapshots(now);
    expect(worker.status).toBe('dead');
  });

  it('emits a Phalaka row and per-Kshetra Suthradhara rows', () => {
    mockLoadRegistry.mockReturnValue([cfg('alpha'), cfg('beta')]);
    mockReadPid.mockReturnValue(null); // no workers running
    mockReadPhalakaPid.mockReturnValue(200);
    mockReadSuthradharaPid.mockImplementation(id => (id === 'alpha' ? 300 : null));
    mockIsAlive.mockReturnValue(true);

    const snaps = readProcessSnapshots(now);
    expect(snaps.find(s => s.kind === 'phalaka')).toMatchObject({ pid: 200, status: 'healthy' });
    const sessions = snaps.filter(s => s.kind === 'suthradhara');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kshetraId: 'alpha', pid: 300, status: 'healthy' });
  });

  it('marks a dead Phalaka pid as dead', () => {
    mockReadPhalakaPid.mockReturnValue(200);
    mockIsAlive.mockReturnValue(false);
    const [phalaka] = readProcessSnapshots(now);
    expect(phalaka).toMatchObject({ kind: 'phalaka', status: 'dead' });
  });

  it('degrades to an empty fleet when the registry cannot be read', () => {
    mockLoadRegistry.mockImplementation(() => {
      throw new Error('registry gone');
    });
    expect(readProcessSnapshots(now)).toEqual([]);
  });
});
