import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ParikshakaOutput } from './types.js';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockReadFile = vi.fn<(path: string, enc: string) => Promise<string>>();
const mockReaddir = vi.fn();
vi.mock('fs/promises', () => ({ readFile: mockReadFile, readdir: mockReaddir }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => '/home/test' };
});

const mockRunParikshaka = vi.fn<() => Promise<ParikshakaOutput>>();
vi.mock('../agents/parikshaka.js', () => ({ runParikshaka: mockRunParikshaka }));

// Parikshaka is read-only — dispatch must never touch git. If it ever did, these
// would be called and the no-commit regression below would fail.
const mockCommitFile = vi.fn<() => Promise<void>>();
const mockPush = vi.fn<() => Promise<void>>();
vi.mock('./git.js', () => ({
  git: vi.fn(() => ({ commitFile: mockCommitFile, push: mockPush })),
}));

const mockBdCreate = vi.fn<() => Promise<string>>();
const mockBdSearch = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ create: mockBdCreate, search: mockBdSearch })),
  syncBeads: mockSyncBeads,
}));

// Failure reporting sinks (Shreni-beads-51c): capture the activity event and the
// notification a dropped backfill must produce.
const mockAppendNotification = vi.fn();
vi.mock('./notifications.js', () => ({ appendNotification: mockAppendNotification }));
const mockEmit = vi.fn();
vi.mock('./activity-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./activity-log.js')>();
  return { ...actual, emit: mockEmit };
});

// ── import after mocks ────────────────────────────────────────────────────────

const {
  collectTestFiles,
  buildMergedDiff,
  fileCoverageGaps,
  runParikshakaDispatch,
  dispatchParikshakaAsync,
  gapKey,
  gapTitle,
  GAP_TITLE_MAX,
  PARIKSHAKA_FAILED_EVENT,
} = await import('./parikshaka-dispatch.js');
const { parikshakaInFlight } = await import('./parikshaka-tracker.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = {
  id: 'proj-42',
  slug: 'fix-auth',
  title: 'Fix auth',
  status: 'in_progress',
  priority: 2,
};

const SILPI_OUTPUT: SilpiOutput = {
  filesChanged: [
    { path: 'src/auth.ts', diff: '+token refresh logic' },
    { path: 'src/session.ts', diff: '+expiry check' },
  ],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth',
  confidenceScore: 90,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: [],
};

const PARIKSHAKA_OUTPUT: ParikshakaOutput = {
  coverageGaps: [
    { feature: 'refresh', description: 'Test token refresh under load', priority: 2 },
    { feature: 'expiry', description: 'Test session expiry edge case', priority: 3 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  mockReaddir.mockResolvedValue([]);
  mockRunParikshaka.mockResolvedValue(PARIKSHAKA_OUTPUT);
  mockCommitFile.mockResolvedValue(undefined);
  mockPush.mockResolvedValue(undefined);
  mockBdCreate.mockResolvedValue('');
  mockBdSearch.mockResolvedValue('[]'); // no existing gap by default
  mockSyncBeads.mockResolvedValue(undefined);
});

// ── buildMergedDiff ───────────────────────────────────────────────────────────

describe('buildMergedDiff', () => {
  it('formats each changed file with its diff', () => {
    const diff = buildMergedDiff(SILPI_OUTPUT);
    expect(diff).toContain('--- src/auth.ts');
    expect(diff).toContain('+token refresh logic');
    expect(diff).toContain('--- src/session.ts');
  });

  it('returns empty string for no changed files', () => {
    const diff = buildMergedDiff({ ...SILPI_OUTPUT, filesChanged: [] });
    expect(diff).toBe('');
  });
});

// ── collectTestFiles ──────────────────────────────────────────────────────────

describe('collectTestFiles', () => {
  it('returns relative paths of .test.ts files', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'auth.test.ts', isDirectory: () => false },
      { name: 'auth.ts', isDirectory: () => false },
    ]);
    const files = await collectTestFiles('/projects/myapp');
    expect(files).toContain('auth.test.ts');
    expect(files).not.toContain('auth.ts');
  });

  it('returns relative paths of .spec.ts files', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'login.spec.ts', isDirectory: () => false },
    ]);
    const files = await collectTestFiles('/projects/myapp');
    expect(files).toContain('login.spec.ts');
  });

  it('skips node_modules and dotfiles', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'node_modules', isDirectory: () => true },
      { name: '.hidden', isDirectory: () => true },
    ]);
    const files = await collectTestFiles('/projects/myapp');
    expect(files).toHaveLength(0);
    expect(mockReaddir).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when directory is unreadable', async () => {
    mockReaddir.mockRejectedValue(new Error('EACCES'));
    const files = await collectTestFiles('/projects/myapp');
    expect(files).toEqual([]);
  });

  it('discovers per-language globs and skips the configured vendor dirs', async () => {
    // Go profile: match *_test.go, skip vendor/.
    mockReaddir.mockResolvedValueOnce([
      { name: 'auth_test.go', isDirectory: () => false },
      { name: 'auth.go', isDirectory: () => false },
      { name: 'vendor', isDirectory: () => true },
    ]);
    const files = await collectTestFiles('/projects/gorepo', ['*_test.go'], ['vendor']);
    expect(files).toEqual(['auth_test.go']);
    // vendor/ was skipped, so readdir was only called for the root.
    expect(mockReaddir).toHaveBeenCalledTimes(1);
  });
});

// ── fileCoverageGaps ──────────────────────────────────────────────────────────

describe('fileCoverageGaps', () => {
  it('files each gap as an unassigned bug with an idempotency-key token in the title', async () => {
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT);
    expect(mockBdCreate).toHaveBeenCalledTimes(2);
    const key0 = gapKey(PARIKSHAKA_OUTPUT.coverageGaps[0]);
    expect(mockBdCreate).toHaveBeenCalledWith(`Test token refresh under load [${key0}]`, 2, 'bug', ['parikshaka'], expect.stringContaining('Test token refresh under load'));
    const key1 = gapKey(PARIKSHAKA_OUTPUT.coverageGaps[1]);
    expect(mockBdCreate).toHaveBeenCalledWith(`Test session expiry edge case [${key1}]`, 3, 'bug', ['parikshaka'], expect.stringContaining('Test session expiry edge case'));
  });

  it('searches by the gap key before filing', async () => {
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT);
    expect(mockBdSearch).toHaveBeenCalledWith(gapKey(PARIKSHAKA_OUTPUT.coverageGaps[0]));
  });

  it('skips a gap that already has a bead (idempotent — no duplicate)', async () => {
    // First gap already filed (search returns a hit), second is new.
    mockBdSearch
      .mockResolvedValueOnce(JSON.stringify([{ id: 'existing-1' }]))
      .mockResolvedValueOnce('[]');
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT);
    expect(mockBdCreate).toHaveBeenCalledTimes(1);
    expect(mockBdCreate).toHaveBeenCalledWith(expect.stringContaining('session expiry'), 3, 'bug', ['parikshaka'], expect.any(String));
  });

  it('gapKey is stable and distinct per gap', () => {
    expect(gapKey({ feature: 'a', description: 'x' })).toBe(gapKey({ feature: 'a', description: 'x' }));
    expect(gapKey({ feature: 'a', description: 'x' })).not.toBe(gapKey({ feature: 'b', description: 'x' }));
  });

  it('calls syncBeads after filing all gaps', async () => {
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT);
    expect(mockSyncBeads).toHaveBeenCalledOnce();
  });

  // Shreni-beads-51c: observed 2026-09-23 — a 928-char description made bd reject
  // the title and the whole batch was dropped.
  it('files a >500-char gap with a truncated title that keeps its [pk…] token, full text in the description', async () => {
    const long = 'Verify the rule handles '.repeat(40) + 'every edge.'; // ~970 chars
    const gap = { feature: 'rules', description: long, priority: 2 };
    await fileCoverageGaps(KSHETRA, { ...PARIKSHAKA_OUTPUT, coverageGaps: [gap] } as ParikshakaOutput);
    const [title, , , , body] = mockBdCreate.mock.calls[0] as unknown as [string, number, string, string[], string];
    expect(Array.from(title).length).toBeLessThanOrEqual(GAP_TITLE_MAX);
    expect(title.endsWith(` [${gapKey(gap)}]`)).toBe(true);
    expect(title).toContain('…');
    expect(body).toContain(long);
  });

  it('gapTitle leaves a short description untouched, collapses whitespace, and never splits a surrogate pair', () => {
    expect(gapTitle('Short  gap\ntext', 'pkabc')).toBe('Short gap text [pkabc]');
    const emoji = '😀'.repeat(300);
    const t = gapTitle(emoji, 'pkabc');
    expect(Array.from(t).length).toBeLessThanOrEqual(GAP_TITLE_MAX);
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
  });

  it('one failing gap does not stop the rest — they are filed and synced, then the failure is thrown', async () => {
    const gaps = [
      { feature: 'a', description: 'gap A', priority: 2 },
      { feature: 'b', description: 'gap B', priority: 2 },
      { feature: 'c', description: 'gap C', priority: 2 },
    ];
    mockBdCreate
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('validation failed for issue'))
      .mockResolvedValueOnce('');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The failure carries the gap's content (the only copy an operator can refile from).
    await expect(fileCoverageGaps(KSHETRA, { ...PARIKSHAKA_OUTPUT, coverageGaps: gaps } as ParikshakaOutput))
      .rejects.toThrow(/1 of 3 coverage gap\(s\) not filed.*gap pk[0-9a-f]+ \(b: "gap B \[pk[0-9a-f]+\]"\): validation failed/);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"description":"gap B"'));
    consoleSpy.mockRestore();
    expect(mockBdCreate).toHaveBeenCalledTimes(3);
    expect(mockSyncBeads).toHaveBeenCalledOnce();
  });

  it('a failing search is isolated per gap too', async () => {
    mockBdSearch.mockRejectedValueOnce(new Error('bd search failed')).mockResolvedValueOnce('[]');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT)).rejects.toThrow(/bd search failed/);
    consoleSpy.mockRestore();
    expect(mockBdCreate).toHaveBeenCalledTimes(1);
    expect(mockSyncBeads).toHaveBeenCalledOnce();
  });

  it('a sync failure after a clean batch is surfaced, not swallowed', async () => {
    mockSyncBeads.mockRejectedValueOnce(new Error('push rejected'));
    await expect(fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT))
      .rejects.toThrow(/0 of 2 coverage gap\(s\) not filed, and 2 newly filed gap\(s\) may not have reached the remote.*push rejected/);
  });

  it('does not call bd.create or syncBeads when no gaps', async () => {
    await fileCoverageGaps(KSHETRA, { ...PARIKSHAKA_OUTPUT, coverageGaps: [] });
    expect(mockBdCreate).not.toHaveBeenCalled();
    expect(mockSyncBeads).not.toHaveBeenCalled();
  });
});

// ── runParikshakaDispatch ─────────────────────────────────────────────────────

describe('runParikshakaDispatch', () => {
  it('calls runParikshaka with kshetra, task, merged diff, and test files', async () => {
    mockReaddir.mockResolvedValue([]);
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    expect(mockRunParikshaka).toHaveBeenCalledWith(
      expect.objectContaining({
        kshetra: KSHETRA,
        task: TASK,
        mergedDiff: expect.stringContaining('src/auth.ts'),
      }),
    );
  });

  it('passes personas when ~/.shreni/personas.yaml exists', async () => {
    mockReadFile.mockResolvedValueOnce('admin: can do everything');
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    expect(mockRunParikshaka).toHaveBeenCalledWith(
      expect.objectContaining({ personas: 'admin: can do everything' }),
    );
  });

  it('omits personas when file is missing', async () => {
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    const ctx = mockRunParikshaka.mock.calls[0][0] as { personas?: string };
    expect(ctx.personas).toBeUndefined();
  });

  it('files coverage gaps as beads after Parikshaka runs', async () => {
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    expect(mockBdCreate).toHaveBeenCalledTimes(2);
  });

  it('never commits or pushes — Parikshaka is read-only, leaving the working tree clean', async () => {
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    expect(mockCommitFile).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

// ── dispatchParikshakaAsync ───────────────────────────────────────────────────

describe('dispatchParikshakaAsync', () => {
  it('returns immediately without awaiting the Parikshaka run', () => {
    let resolved = false;
    mockRunParikshaka.mockImplementation(() =>
      new Promise(r => setTimeout(() => { resolved = true; r(PARIKSHAKA_OUTPUT); }, 100)),
    );
    dispatchParikshakaAsync(KSHETRA, TASK, SILPI_OUTPUT);
    expect(resolved).toBe(false);
  });

  it('does not propagate errors to the caller', async () => {
    mockRunParikshaka.mockRejectedValue(new Error('Parikshaka exploded'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => dispatchParikshakaAsync(KSHETRA, TASK, SILPI_OUTPUT)).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    consoleSpy.mockRestore();
  });

  it('logs errors to console.error on failure', async () => {
    mockRunParikshaka.mockRejectedValue(new Error('Parikshaka exploded'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatchParikshakaAsync(KSHETRA, TASK, SILPI_OUTPUT);
    await new Promise(r => setTimeout(r, 0));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Parikshaka exploded'));
    consoleSpy.mockRestore();
  });

  it('makes a failure observable: an error on the activity stream and a notification (Shreni-beads-51c)', async () => {
    mockRunParikshaka.mockRejectedValue(new Error('bd create failed: title must be 500 characters or less'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEmit.mockClear();
    mockAppendNotification.mockClear();
    dispatchParikshakaAsync(KSHETRA, TASK, SILPI_OUTPUT);
    await new Promise(r => setTimeout(r, 0));
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', kshetra: 'myapp', beadId: 'proj-42', message: expect.stringContaining('title must be 500 characters'),
    }));
    expect(mockAppendNotification).toHaveBeenCalledWith('myapp', expect.objectContaining({
      event: PARIKSHAKA_FAILED_EVENT, beadId: 'proj-42', reason: expect.stringContaining('500 characters'),
    }));
    consoleSpy.mockRestore();
  });

  it('a successful backfill produces no error event or notification', async () => {
    mockEmit.mockClear();
    mockAppendNotification.mockClear();
    dispatchParikshakaAsync({ ...KSHETRA, id: 'ok-run' }, TASK, SILPI_OUTPUT);
    await new Promise(r => setTimeout(r, 0));
    expect(mockEmit.mock.calls.filter(c => (c[0] as { type: string }).type === 'error')).toHaveLength(0);
    expect(mockAppendNotification).not.toHaveBeenCalled();
  });

  // Epic 7h3 / Study B3: drain's in-flight signal must cover this backfill. Use a
  // per-test kshetra id — the tracker is a module singleton and sibling tests here
  // fire dispatches they never await, which would otherwise leak in-flight counts.
  it('marks the kshetra in-flight while running and clears it once settled', async () => {
    const k = { ...KSHETRA, id: 'inflight-settle' };
    // begin/end bracket the whole backfill: in-flight is set synchronously on
    // dispatch (before any await) and cleared only once the chain fully settles.
    expect(parikshakaInFlight(k.id)).toBe(false);
    dispatchParikshakaAsync(k, TASK, SILPI_OUTPUT);
    expect(parikshakaInFlight(k.id)).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(parikshakaInFlight(k.id)).toBe(false);
  });

  it('clears the in-flight signal even when the backfill throws', async () => {
    const k = { ...KSHETRA, id: 'inflight-throw' };
    mockRunParikshaka.mockRejectedValue(new Error('boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatchParikshakaAsync(k, TASK, SILPI_OUTPUT);
    await new Promise(r => setTimeout(r, 0));
    expect(parikshakaInFlight(k.id)).toBe(false);
    consoleSpy.mockRestore();
  });
});