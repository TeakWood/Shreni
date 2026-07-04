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

// ── import after mocks ────────────────────────────────────────────────────────

const {
  collectTestFiles,
  buildMergedDiff,
  fileCoverageGaps,
  runParikshakaDispatch,
  dispatchParikshakaAsync,
  gapKey,
} = await import('./parikshaka-dispatch.js');

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
    expect(mockBdCreate).toHaveBeenCalledWith(`Test token refresh under load [${key0}]`, 2, 'bug', ['parikshaka']);
    const key1 = gapKey(PARIKSHAKA_OUTPUT.coverageGaps[1]);
    expect(mockBdCreate).toHaveBeenCalledWith(`Test session expiry edge case [${key1}]`, 3, 'bug', ['parikshaka']);
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
    expect(mockBdCreate).toHaveBeenCalledWith(expect.stringContaining('session expiry'), 3, 'bug', ['parikshaka']);
  });

  it('gapKey is stable and distinct per gap', () => {
    expect(gapKey({ feature: 'a', description: 'x' })).toBe(gapKey({ feature: 'a', description: 'x' }));
    expect(gapKey({ feature: 'a', description: 'x' })).not.toBe(gapKey({ feature: 'b', description: 'x' }));
  });

  it('calls syncBeads after filing all gaps', async () => {
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT);
    expect(mockSyncBeads).toHaveBeenCalledOnce();
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
});