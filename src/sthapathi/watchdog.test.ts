import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// ── mocks (for runWatchdogOnce) ──────────────────────────────────────────────

const mockGetProgressState = vi.fn();
const mockIsManuallyPaused = vi.fn<() => boolean>();
const mockPauseKshetra = vi.fn();
const mockSetStuck = vi.fn();
vi.mock('../kshetra/state.js', () => ({
  getProgressState: () => mockGetProgressState(),
  isKshetraManuallyPaused: () => mockIsManuallyPaused(),
  pauseKshetra: (...a: unknown[]) => mockPauseKshetra(...a),
  setStuck: (...a: unknown[]) => mockSetStuck(...a),
}));

const mockStatSync = vi.fn<(p: string) => { mtimeMs: number }>();
vi.mock('fs', () => ({ statSync: (p: string) => mockStatSync(p) }));

vi.mock('./activity-log.js', () => ({
  logPath: (id: string) => `/log/${id}.jsonl`,
  heartbeatPath: (id: string) => `/log/${id}.heartbeat`,
}));

const mockNotifyOperator = vi.fn<() => Promise<void>>();
vi.mock('./errors.js', () => ({ notifyOperator: (...a: unknown[]) => mockNotifyOperator(...a) }));

// ── import after mocks ───────────────────────────────────────────────────────

const { evaluateStuck, remediationFor, runWatchdogOnce, STUCK_THRESHOLD_MS, MAX_OUTCOME_REPEAT } =
  await import('./watchdog.js');

const KSHETRA = { id: 'myapp', name: 'Myapp' } as unknown as KshetraConfig;

// ── evaluateStuck (pure) ─────────────────────────────────────────────────────

describe('evaluateStuck', () => {
  const base = {
    phase: 'WORKING' as const,
    manuallyPaused: false,
    heartbeatAgeMs: 0,
    outcomeRepeatCount: 0,
    lastOutcome: undefined,
  };

  it('is not stuck under thresholds', () => {
    expect(evaluateStuck(base).stuck).toBe(false);
  });

  it('is never stuck when already manually paused', () => {
    expect(evaluateStuck({ ...base, manuallyPaused: true, outcomeRepeatCount: 99 }).stuck).toBe(false);
  });

  it('trips on a repeated non-advancing outcome (repeat condition)', () => {
    const v = evaluateStuck({ ...base, outcomeRepeatCount: MAX_OUTCOME_REPEAT, lastOutcome: 'preflight: branch already exists: bead-x' });
    expect(v.stuck).toBe(true);
    expect(v.reason).toContain('repeated');
    expect(v.remediation).toContain('branch -D');
  });

  it('trips on a stale heartbeat while busy (liveness condition)', () => {
    const v = evaluateStuck({ ...base, phase: 'WORKING', heartbeatAgeMs: STUCK_THRESHOLD_MS + 1 });
    expect(v.stuck).toBe(true);
    expect(v.reason).toContain('no worker heartbeat');
  });

  it('does NOT trip on a stale heartbeat while IDLE (idle is not stuck)', () => {
    expect(evaluateStuck({ ...base, phase: 'IDLE', heartbeatAgeMs: STUCK_THRESHOLD_MS * 10 }).stuck).toBe(false);
  });

  it('does NOT trip on the liveness condition when there is no heartbeat yet', () => {
    expect(evaluateStuck({ ...base, phase: 'WORKING', heartbeatAgeMs: null }).stuck).toBe(false);
  });

  it('does NOT trip when idle by design (empty queue) despite a stale heartbeat', () => {
    // Same stale-heartbeat SELECTING input trips without idleNoWork, but an empty
    // ready queue means "nothing to do", not "hung" (Shreni-beads-vwa).
    const stale = { ...base, phase: 'SELECTING' as const, heartbeatAgeMs: STUCK_THRESHOLD_MS * 2 };
    expect(evaluateStuck(stale).stuck).toBe(true);
    expect(evaluateStuck({ ...stale, idleNoWork: true }).stuck).toBe(false);
  });

  it('idle by design also suppresses a would-be repeat-stall trip', () => {
    expect(
      evaluateStuck({ ...base, outcomeRepeatCount: MAX_OUTCOME_REPEAT, lastOutcome: 'x', idleNoWork: true }).stuck,
    ).toBe(false);
  });

  it('honors custom thresholds', () => {
    expect(evaluateStuck({ ...base, outcomeRepeatCount: 2, lastOutcome: 'x', thresholds: { maxRepeat: 2 } }).stuck).toBe(true);
  });
});

// ── remediationFor ───────────────────────────────────────────────────────────

describe('remediationFor', () => {
  it('gives branch-specific steps for "branch already exists"', () => {
    expect(remediationFor('preflight: branch already exists: bead-x')).toContain('branch -D');
  });
  it('gives tree-reset steps for a dirty tree', () => {
    expect(remediationFor('preflight: dirty working tree: a.ts')).toContain('clean -fd');
  });
  it('names the ACK verb (shreni resume + stop/start) in the generic hint', () => {
    const r = remediationFor(undefined);
    expect(r).toContain('shreni resume');
    expect(r).toContain('RECOVER acknowledges');
  });
});

// ── runWatchdogOnce ──────────────────────────────────────────────────────────

describe('runWatchdogOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsManuallyPaused.mockReturnValue(false);
    mockStatSync.mockReturnValue({ mtimeMs: 1_000_000 });
    mockGetProgressState.mockReturnValue({ outcomeRepeatCount: 0, lastOutcome: undefined, stuck: undefined });
  });

  it('escalates on a trip: setStuck + manual pause + notify', async () => {
    mockGetProgressState.mockReturnValue({ outcomeRepeatCount: MAX_OUTCOME_REPEAT, lastOutcome: 'preflight: dirty working tree: a.ts', stuck: undefined });

    const v = await runWatchdogOnce(KSHETRA, () => 'PREPARING', 2_000_000);

    expect(v.stuck).toBe(true);
    expect(mockSetStuck).toHaveBeenCalledOnce();
    expect(mockPauseKshetra).toHaveBeenCalledWith(KSHETRA, expect.objectContaining({ reason: 'stuck', manual: true }));
    expect(mockNotifyOperator).toHaveBeenCalledWith(KSHETRA, null, 'stuck', expect.any(String), expect.any(String));
  });

  it('does nothing when not stuck', async () => {
    const v = await runWatchdogOnce(KSHETRA, () => 'WORKING', 1_000_000);
    expect(v.stuck).toBe(false);
    expect(mockPauseKshetra).not.toHaveBeenCalled();
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it('reads liveness from the heartbeat file, not the activity log (RC1 regression)', async () => {
    // A long SILENT tool call: activity.jsonl is stale but the worker heartbeat is
    // fresh. Must NOT trip — this is the 2026-06-30 false-trip the watchdog design fixes.
    const now = 100 * 60_000; // 100 min
    mockStatSync.mockImplementation((p: string) =>
      p.endsWith('.heartbeat') ? { mtimeMs: now - 1_000 } : { mtimeMs: now - 90 * 60_000 },
    );

    const v = await runWatchdogOnce(KSHETRA, () => 'WORKING', now);

    expect(v.stuck).toBe(false);
    expect(mockStatSync).toHaveBeenCalledWith('/log/myapp.heartbeat');
    expect(mockSetStuck).not.toHaveBeenCalled();
  });

  it('trips on a stale heartbeat while busy', async () => {
    mockStatSync.mockImplementation((p: string) =>
      p.endsWith('.heartbeat') ? { mtimeMs: 0 } : { mtimeMs: 0 },
    );
    const now = STUCK_THRESHOLD_MS + 60_000;
    const v = await runWatchdogOnce(KSHETRA, () => 'WORKING', now);
    expect(v.stuck).toBe(true);
    expect(v.reason).toContain('no worker heartbeat');
    expect(mockPauseKshetra).toHaveBeenCalled();
  });

  it('is idempotent — does not re-notify when already flagged stuck', async () => {
    mockGetProgressState.mockReturnValue({ outcomeRepeatCount: 99, stuck: { since: 't', reason: 'r', remediation: 'm' } });
    await runWatchdogOnce(KSHETRA, () => 'WORKING', 9_000_000);
    expect(mockSetStuck).not.toHaveBeenCalled();
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it('does NOT escalate an idle empty-queue Kshetra even with a stale heartbeat (Shreni-beads-vwa)', async () => {
    // Worker idle in SELECTING, heartbeat long stale, but the ready queue is empty.
    mockStatSync.mockReturnValue({ mtimeMs: 0 });
    const now = STUCK_THRESHOLD_MS + 60_000;

    const v = await runWatchdogOnce(KSHETRA, () => 'SELECTING', now, { hasReadyWork: async () => false });

    expect(v.stuck).toBe(false);
    expect(mockSetStuck).not.toHaveBeenCalled();
    expect(mockPauseKshetra).not.toHaveBeenCalled();
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it('DOES escalate when the queue has ready work the worker cannot pick up (stale heartbeat)', async () => {
    // Same stale-heartbeat SELECTING, but ready work exists — a genuine wedge.
    mockStatSync.mockReturnValue({ mtimeMs: 0 });
    const now = STUCK_THRESHOLD_MS + 60_000;

    const v = await runWatchdogOnce(KSHETRA, () => 'SELECTING', now, { hasReadyWork: async () => true });

    expect(v.stuck).toBe(true);
    expect(mockNotifyOperator).toHaveBeenCalled();
  });

  it('does not probe the ready queue while WORKING (a task is in flight)', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 0 });
    const now = STUCK_THRESHOLD_MS + 60_000;
    const hasReadyWork = vi.fn(async () => false);

    const v = await runWatchdogOnce(KSHETRA, () => 'WORKING', now, { hasReadyWork });

    expect(hasReadyWork).not.toHaveBeenCalled(); // WORKING is never idle-by-design
    expect(v.stuck).toBe(true); // stale heartbeat while busy still trips
  });

  it('honors a kshetra.yaml watchdog override (lower maxOutcomeRepeat trips sooner)', async () => {
    const k = { id: 'myapp', name: 'Myapp', watchdog: { maxOutcomeRepeat: 2 } } as unknown as KshetraConfig;
    mockGetProgressState.mockReturnValue({ outcomeRepeatCount: 2, lastOutcome: 'x', stuck: undefined });
    const v = await runWatchdogOnce(k, () => 'WORKING', 1_000_000);
    expect(v.stuck).toBe(true); // would NOT trip at the default of 5
    expect(mockPauseKshetra).toHaveBeenCalled();
  });
});
