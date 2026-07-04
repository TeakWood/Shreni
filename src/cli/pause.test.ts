import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockPauseKshetra = vi.fn<() => void>();
const mockResumeKshetra = vi.fn<() => void>();
const mockLoadState = vi.fn<() => { kshetras: Record<string, unknown> }>();
vi.mock('../kshetra/state', () => ({
  pauseKshetra: mockPauseKshetra,
  resumeKshetra: mockResumeKshetra,
  loadState: mockLoadState,
  isKshetraManuallyPaused: vi.fn(() => false),
}));

const mockReadPid = vi.fn<() => number | null>();
const mockIsAlive = vi.fn<(pid: number) => boolean>();
vi.mock('./pid', () => ({ readPid: mockReadPid, isAlive: mockIsAlive }));

// ── imports after mocks ───────────────────────────────────────────────────────

const { pauseKshetraById, resumeKshetraById } = await import('./pause');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadRegistry.mockReturnValue([KSHETRA]);
  mockLoadState.mockReturnValue({ kshetras: {} });
  mockReadPid.mockReturnValue(4242);
  mockIsAlive.mockReturnValue(true);
});

// ── pauseKshetraById ──────────────────────────────────────────────────────────

describe('pauseKshetraById', () => {
  it('returns paused for a known kshetra id', () => {
    const result = pauseKshetraById('myapp');
    expect(result).toEqual({ status: 'paused', id: 'myapp' });
  });

  it('calls pauseKshetra with manual:true', () => {
    pauseKshetraById('myapp');
    expect(mockPauseKshetra).toHaveBeenCalledWith(
      KSHETRA,
      expect.objectContaining({ manual: true }),
    );
  });

  it('sets reason to "manual"', () => {
    pauseKshetraById('myapp');
    expect(mockPauseKshetra).toHaveBeenCalledWith(
      KSHETRA,
      expect.objectContaining({ reason: 'manual' }),
    );
  });

  it('returns not_found for an unknown id', () => {
    const result = pauseKshetraById('unknown-id');
    expect(result).toEqual({ status: 'not_found', id: 'unknown-id' });
    expect(mockPauseKshetra).not.toHaveBeenCalled();
  });
});

// ── resumeKshetraById ─────────────────────────────────────────────────────────

describe('resumeKshetraById', () => {
  it('returns resumed for a known kshetra id', () => {
    const result = resumeKshetraById('myapp');
    expect(result).toEqual({ status: 'resumed', id: 'myapp' });
  });

  it('calls resumeKshetra with the correct kshetra', () => {
    resumeKshetraById('myapp');
    expect(mockResumeKshetra).toHaveBeenCalledWith(KSHETRA);
  });

  it('returns not_found for an unknown id', () => {
    const result = resumeKshetraById('ghost');
    expect(result).toEqual({ status: 'not_found', id: 'ghost' });
    expect(mockResumeKshetra).not.toHaveBeenCalled();
  });

  it('clears a reason:stuck pause and signals in-process self-heal when the worker is alive', () => {
    mockLoadState.mockReturnValue({
      kshetras: { myapp: { paused: true, reason: 'stuck', requiresManualResume: true } },
    });
    mockReadPid.mockReturnValue(4242);
    mockIsAlive.mockReturnValue(true);
    const result = resumeKshetraById('myapp');
    expect(result).toEqual({ status: 'resumed_self_heal', id: 'myapp' });
    // The pause is still cleared — the live worker observes the transition and heals.
    expect(mockResumeKshetra).toHaveBeenCalledWith(KSHETRA);
  });

  it('clears a reason:stuck pause but redirects to start when no worker is running', () => {
    mockLoadState.mockReturnValue({
      kshetras: { myapp: { paused: true, reason: 'stuck', requiresManualResume: true } },
    });
    mockReadPid.mockReturnValue(null);
    const result = resumeKshetraById('myapp');
    expect(result).toEqual({
      status: 'resumed_needs_start',
      id: 'myapp',
      hint: 'shreni start --kshetra myapp',
    });
    expect(mockResumeKshetra).toHaveBeenCalledWith(KSHETRA);
  });

  it('treats a stuck pause with a dead (stale-pid) worker as needing start', () => {
    mockLoadState.mockReturnValue({
      kshetras: { myapp: { paused: true, reason: 'stuck', requiresManualResume: true } },
    });
    mockReadPid.mockReturnValue(9999);
    mockIsAlive.mockReturnValue(false);
    const result = resumeKshetraById('myapp');
    expect(result).toEqual({
      status: 'resumed_needs_start',
      id: 'myapp',
      hint: 'shreni start --kshetra myapp',
    });
  });

  it('resumes normally for a non-stuck pause (e.g. git_failed) without checking worker liveness', () => {
    mockLoadState.mockReturnValue({
      kshetras: { myapp: { paused: true, reason: 'git_failed', requiresManualResume: true } },
    });
    const result = resumeKshetraById('myapp');
    expect(result).toEqual({ status: 'resumed', id: 'myapp' });
    expect(mockResumeKshetra).toHaveBeenCalledWith(KSHETRA);
    expect(mockReadPid).not.toHaveBeenCalled();
  });
});