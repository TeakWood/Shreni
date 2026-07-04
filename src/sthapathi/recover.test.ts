import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockList = vi.fn<() => Promise<string>>();
const mockAddNote = vi.fn<() => Promise<string>>();
const mockReopen = vi.fn<() => Promise<string>>();
const mockFlag = vi.fn<() => Promise<string>>();
const mockClaim = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ list: mockList, addNote: mockAddNote, reopen: mockReopen, flag: mockFlag, claim: mockClaim })),
  syncBeads: mockSyncBeads,
}));

const mockResetHard = vi.fn<() => Promise<void>>();
const mockCheckout = vi.fn<() => Promise<void>>();
const mockClean = vi.fn<() => Promise<void>>();
const mockBranches = vi.fn<() => Promise<string[]>>();
const mockDeleteBranch = vi.fn<() => Promise<void>>();

vi.mock('./git.js', () => ({
  git: vi.fn(() => ({
    resetHard: mockResetHard,
    checkout: mockCheckout,
    clean: mockClean,
    branches: mockBranches,
    deleteBranch: mockDeleteBranch,
  })),
}));

const mockRecordBeadAttempt = vi.fn<(k: KshetraConfig, id: string) => number>();
const mockRecordProgress = vi.fn<() => void>();
vi.mock('../kshetra/state.js', () => ({
  recordBeadAttempt: mockRecordBeadAttempt,
  recordProgress: mockRecordProgress,
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { recoverKshetra, scheduleResume, parseInFlightTasks, MAX_RECOVER_ATTEMPTS } = await import('./recover.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads', remote: '' },
  agents: { maxRoundsPerBead: 3 },
} as unknown as KshetraConfig;

function inProgressJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'bead-42', slug: 'fix-bug', title: 'Fix bug', priority: 1, status: 'in_progress', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue('[]');
  mockAddNote.mockResolvedValue('ok');
  mockReopen.mockResolvedValue('ok');
  mockFlag.mockResolvedValue('ok');
  mockClaim.mockResolvedValue('ok');
  mockSyncBeads.mockResolvedValue(undefined);
  mockResetHard.mockResolvedValue(undefined);
  mockCheckout.mockResolvedValue(undefined);
  mockClean.mockResolvedValue(undefined);
  mockBranches.mockResolvedValue([]);
  mockDeleteBranch.mockResolvedValue(undefined);
  mockRecordBeadAttempt.mockReturnValue(1);
});

// ── parseInFlightTasks ──────────────────────────────────────────────────────

describe('parseInFlightTasks', () => {
  it('returns [] for malformed JSON', () => {
    expect(parseInFlightTasks('not-json')).toEqual([]);
  });

  it('returns [] when not an array', () => {
    expect(parseInFlightTasks('{"id":"x"}')).toEqual([]);
  });

  it('skips items missing id or title', () => {
    expect(parseInFlightTasks(JSON.stringify([{ id: 'x' }, { title: 'y' }]))).toEqual([]);
  });

  it('parses valid in-progress items', () => {
    const tasks = parseInFlightTasks(JSON.stringify([inProgressJson()]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'bead-42', title: 'Fix bug', status: 'in_progress' });
  });
});

// ── recoverKshetra ────────────────────────────────────────────────────────────

describe('recoverKshetra', () => {
  it('resets the work tree to a clean main (resetHard → checkout main → clean)', async () => {
    const order: string[] = [];
    mockResetHard.mockImplementation(async () => { order.push('reset'); });
    mockCheckout.mockImplementation(async () => { order.push('checkout'); });
    mockClean.mockImplementation(async () => { order.push('clean'); });

    await recoverKshetra(KSHETRA);

    expect(order).toEqual(['reset', 'checkout', 'clean']);
    expect(mockCheckout).toHaveBeenCalledWith('main');
  });

  it('force-deletes every stale bead-* branch', async () => {
    mockBranches.mockResolvedValue(['bead-1/a', 'bead-2/b']);
    await recoverKshetra(KSHETRA);
    expect(mockBranches).toHaveBeenCalledWith('bead-');
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-1/a', { force: true });
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-2/b', { force: true });
  });

  it('keeps opts.keepBranch when invoked mid-run', async () => {
    mockBranches.mockResolvedValue(['bead-1/a', 'bead-active/x']);
    await recoverKshetra(KSHETRA, { keepBranch: 'bead-active/x' });
    expect(mockDeleteBranch).toHaveBeenCalledWith('bead-1/a', { force: true });
    expect(mockDeleteBranch).not.toHaveBeenCalledWith('bead-active/x', expect.anything());
  });

  it('reopens an orphaned in_progress bead under the attempt budget', async () => {
    mockList.mockResolvedValue(JSON.stringify([inProgressJson()]));
    mockRecordBeadAttempt.mockReturnValue(1);

    await recoverKshetra(KSHETRA);

    expect(mockRecordBeadAttempt).toHaveBeenCalledWith(KSHETRA, 'bead-42');
    expect(mockReopen).toHaveBeenCalledWith('bead-42');
    expect(mockAddNote).toHaveBeenCalledWith('bead-42', expect.stringContaining('Recovered after restart'));
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('escalates (flags, does not reopen) once the attempt budget is exceeded', async () => {
    mockList.mockResolvedValue(JSON.stringify([inProgressJson()]));
    mockRecordBeadAttempt.mockReturnValue(MAX_RECOVER_ATTEMPTS + 1);

    await recoverKshetra(KSHETRA);

    expect(mockFlag).toHaveBeenCalledWith('bead-42', expect.stringContaining('exceeded'));
    expect(mockReopen).not.toHaveBeenCalled();
  });

  it('honors a kshetra.yaml maxRecoverAttempts override', async () => {
    const k = { ...KSHETRA, watchdog: { maxRecoverAttempts: 1 } } as unknown as KshetraConfig;
    mockList.mockResolvedValue(JSON.stringify([inProgressJson()]));
    mockRecordBeadAttempt.mockReturnValue(2); // exceeds the override of 1

    await recoverKshetra(k);

    expect(mockFlag).toHaveBeenCalledWith('bead-42', expect.stringContaining('exceeded 1'));
    expect(mockReopen).not.toHaveBeenCalled();
  });

  it('does nothing to beads when none are in_progress', async () => {
    mockList.mockResolvedValue('[]');
    await recoverKshetra(KSHETRA);
    expect(mockReopen).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('handles malformed bd list output gracefully', async () => {
    mockList.mockResolvedValue('not-json');
    await expect(recoverKshetra(KSHETRA)).resolves.not.toThrow();
    expect(mockReopen).not.toHaveBeenCalled();
  });

  it('reopens multiple stranded beads', async () => {
    mockList.mockResolvedValue(JSON.stringify([
      inProgressJson({ id: 'bead-1' }),
      inProgressJson({ id: 'bead-2' }),
    ]));
    await recoverKshetra(KSHETRA);
    expect(mockReopen).toHaveBeenCalledWith('bead-1');
    expect(mockReopen).toHaveBeenCalledWith('bead-2');
  });

  it('syncs beads at the end', async () => {
    await recoverKshetra(KSHETRA);
    expect(mockSyncBeads).toHaveBeenCalled();
  });

  it('returns the reopened beads as resumable', async () => {
    mockList.mockResolvedValue(JSON.stringify([
      inProgressJson({ id: 'bead-1' }),
      inProgressJson({ id: 'bead-2' }),
    ]));
    const resumable = await recoverKshetra(KSHETRA);
    expect(resumable.map(t => t.id)).toEqual(['bead-1', 'bead-2']);
  });

  it('does NOT return a bead that exceeded the attempt budget (escalated, not resumed)', async () => {
    mockList.mockResolvedValue(JSON.stringify([inProgressJson({ id: 'bead-1' })]));
    mockRecordBeadAttempt.mockReturnValue(MAX_RECOVER_ATTEMPTS + 1);
    const resumable = await recoverKshetra(KSHETRA);
    expect(resumable).toEqual([]);
  });

  it('returns [] when nothing was in flight', async () => {
    mockList.mockResolvedValue('[]');
    expect(await recoverKshetra(KSHETRA)).toEqual([]);
  });
});

// ── scheduleResume ────────────────────────────────────────────────────────────

describe('scheduleResume', () => {
  const TASK = { id: 'bead-42', slug: 'fix-bug', title: 'Fix bug', status: 'in_progress', priority: 1 } as const;

  it('re-claims the bead and runs the loop on its branch — no pickup/health gate', async () => {
    const run = vi.fn(async () => ({ approved: true, note: 'done' }));
    const result = await scheduleResume(KSHETRA, { ...TASK }, run);

    expect(mockClaim).toHaveBeenCalledWith('bead-42');
    expect(run).toHaveBeenCalledWith(KSHETRA, expect.objectContaining({ id: 'bead-42' }), 'bead-bead-42/fix-bug');
    expect(result).toEqual({ approved: true, note: 'done' });
  });

  it('records forward progress so the watchdog does not trip on the resumed bead', async () => {
    await scheduleResume(KSHETRA, { ...TASK }, vi.fn(async () => ({ approved: false, note: 'x' })));
    expect(mockRecordProgress).toHaveBeenCalledWith(KSHETRA);
  });

  it('claims before dispatching the loop', async () => {
    const order: string[] = [];
    mockClaim.mockImplementation(async () => { order.push('claim'); return 'ok'; });
    const run = vi.fn(async () => { order.push('run'); return { approved: true, note: 'done' }; });
    await scheduleResume(KSHETRA, { ...TASK }, run);
    expect(order).toEqual(['claim', 'run']);
  });
});
