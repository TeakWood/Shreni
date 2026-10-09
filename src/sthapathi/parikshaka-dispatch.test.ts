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

// The task store files each gap (keyed, so a gap seen twice is filed once).
type Gap = { title: string; description: string; priority: number; key: string; sourceTaskId?: string };
const mockFileGap = vi.fn<(gap: Gap) => Promise<'filed' | 'exists'>>();
vi.mock('./task-store.js', () => ({ engineStore: vi.fn(() => ({ fileGap: mockFileGap })) }));

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
  mockFileGap.mockResolvedValue('filed'); // no existing gap by default
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
  it('files each gap keyed, with an idempotency-key token in the title and the full text in the description', async () => {
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT, 'proj-42');
    expect(mockFileGap).toHaveBeenCalledTimes(2);
    const key0 = gapKey(PARIKSHAKA_OUTPUT.coverageGaps[0]);
    expect(mockFileGap).toHaveBeenCalledWith({
      title: `Test token refresh under load [${key0}]`, description: expect.stringContaining('Test token refresh under load'),
      priority: 2, key: key0, sourceTaskId: 'proj-42',
    });
    const key1 = gapKey(PARIKSHAKA_OUTPUT.coverageGaps[1]);
    expect(mockFileGap).toHaveBeenCalledWith(expect.objectContaining({ title: `Test session expiry edge case [${key1}]`, priority: 3, key: key1 }));
  });

  it('a gap the store already has is skipped quietly (idempotent)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mockFileGap.mockResolvedValueOnce('exists').mockResolvedValueOnce('filed');
    await expect(fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT)).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('gap already filed'));
    info.mockRestore();
  });

  it('gapKey is stable and distinct per gap', () => {
    expect(gapKey({ feature: 'a', description: 'x' })).toBe(gapKey({ feature: 'a', description: 'x' }));
    expect(gapKey({ feature: 'a', description: 'x' })).not.toBe(gapKey({ feature: 'b', description: 'x' }));
  });

  // Shreni-beads-51c: a 928-char description once made the tracker reject the
  // title and the whole batch was dropped.
  it('files a >500-char gap with a truncated title that keeps its [pk…] token, full text in the description', async () => {
    const long = 'Verify the rule handles '.repeat(40) + 'every edge.'; // ~970 chars
    const gap = { feature: 'rules', description: long, priority: 2 };
    await fileCoverageGaps(KSHETRA, { ...PARIKSHAKA_OUTPUT, coverageGaps: [gap] } as ParikshakaOutput);
    const { title, description } = mockFileGap.mock.calls[0][0];
    expect(Array.from(title).length).toBeLessThanOrEqual(GAP_TITLE_MAX);
    expect(title.endsWith(` [${gapKey(gap)}]`)).toBe(true);
    expect(title).toContain('…');
    expect(description).toContain(long);
  });

  it('gapTitle leaves a short description untouched, collapses whitespace, and never splits a surrogate pair', () => {
    expect(gapTitle('Short  gap\ntext', 'pkabc')).toBe('Short gap text [pkabc]');
    const emoji = '😀'.repeat(300);
    const t = gapTitle(emoji, 'pkabc');
    expect(Array.from(t).length).toBeLessThanOrEqual(GAP_TITLE_MAX);
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
  });

  it('one failing gap does not stop the rest — they are filed, then the failure is thrown', async () => {
    const gaps = [
      { feature: 'a', description: 'gap A', priority: 2 },
      { feature: 'b', description: 'gap B', priority: 2 },
      { feature: 'c', description: 'gap C', priority: 2 },
    ];
    mockFileGap
      .mockResolvedValueOnce('filed')
      .mockRejectedValueOnce(new Error('validation failed for issue'))
      .mockResolvedValueOnce('filed');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The failure carries the gap's content (the only copy an operator can refile from).
    await expect(fileCoverageGaps(KSHETRA, { ...PARIKSHAKA_OUTPUT, coverageGaps: gaps } as ParikshakaOutput))
      .rejects.toThrow(/1 of 3 coverage gap\(s\) not filed.*gap pk[0-9a-f]+ \(b\): validation failed/);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"description":"gap B"'));
    consoleSpy.mockRestore();
    expect(mockFileGap).toHaveBeenCalledTimes(3);
  });

  it('files nothing when there are no gaps', async () => {
    await fileCoverageGaps(KSHETRA, { ...PARIKSHAKA_OUTPUT, coverageGaps: [] });
    expect(mockFileGap).not.toHaveBeenCalled();
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

  it('files coverage gaps after Parikshaka runs, linked to the merged task', async () => {
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    expect(mockFileGap).toHaveBeenCalledTimes(2);
    expect(mockFileGap).toHaveBeenCalledWith(expect.objectContaining({ sourceTaskId: 'proj-42' }));
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