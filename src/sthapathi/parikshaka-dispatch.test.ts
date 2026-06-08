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

const mockCommitFile = vi.fn<() => Promise<void>>();
const mockPush = vi.fn<() => Promise<void>>();
vi.mock('./git.js', () => ({
  git: vi.fn(() => ({ commitFile: mockCommitFile, push: mockPush })),
}));

const mockBdCreate = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ create: mockBdCreate })),
  syncBeads: mockSyncBeads,
}));

// ── import after mocks ────────────────────────────────────────────────────────

const {
  collectTestFiles,
  buildMergedDiff,
  commitParikshakaTestFiles,
  fileCoverageGaps,
  runParikshakaDispatch,
  dispatchParikshakaAsync,
} = await import('./parikshaka-dispatch.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: '', mode: 'embedded' },
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
  testFilesAdded: ['src/auth.e2e.ts', 'src/session.e2e.ts'],
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
    const files = await collectTestFiles('/projects/sishya');
    expect(files).toContain('auth.test.ts');
    expect(files).not.toContain('auth.ts');
  });

  it('returns relative paths of .spec.ts files', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'login.spec.ts', isDirectory: () => false },
    ]);
    const files = await collectTestFiles('/projects/sishya');
    expect(files).toContain('login.spec.ts');
  });

  it('skips node_modules and dotfiles', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'node_modules', isDirectory: () => true },
      { name: '.hidden', isDirectory: () => true },
    ]);
    const files = await collectTestFiles('/projects/sishya');
    expect(files).toHaveLength(0);
    expect(mockReaddir).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when directory is unreadable', async () => {
    mockReaddir.mockRejectedValue(new Error('EACCES'));
    const files = await collectTestFiles('/projects/sishya');
    expect(files).toEqual([]);
  });
});

// ── commitParikshakaTestFiles ─────────────────────────────────────────────────

describe('commitParikshakaTestFiles', () => {
  it('calls commitFile for each test file with correct message', async () => {
    await commitParikshakaTestFiles(KSHETRA, TASK, ['src/auth.e2e.ts', 'src/session.e2e.ts']);
    expect(mockCommitFile).toHaveBeenCalledTimes(2);
    expect(mockCommitFile).toHaveBeenCalledWith('src/auth.e2e.ts', 'parikshaka: add tests for proj-42');
    expect(mockCommitFile).toHaveBeenCalledWith('src/session.e2e.ts', 'parikshaka: add tests for proj-42');
  });

  it('pushes to origin/<mainBranch> after committing', async () => {
    await commitParikshakaTestFiles(KSHETRA, TASK, ['src/auth.e2e.ts']);
    expect(mockPush).toHaveBeenCalledWith('origin', 'main');
  });

  it('does not push when no test files added', async () => {
    await commitParikshakaTestFiles(KSHETRA, TASK, []);
    expect(mockCommitFile).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

// ── fileCoverageGaps ──────────────────────────────────────────────────────────

describe('fileCoverageGaps', () => {
  it('calls bd.create for each coverage gap with type "parikshaka"', async () => {
    await fileCoverageGaps(KSHETRA, PARIKSHAKA_OUTPUT);
    expect(mockBdCreate).toHaveBeenCalledTimes(2);
    expect(mockBdCreate).toHaveBeenCalledWith('Test token refresh under load', 2, 'parikshaka');
    expect(mockBdCreate).toHaveBeenCalledWith('Test session expiry edge case', 3, 'parikshaka');
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

  it('commits test files and files gaps after Parikshaka runs', async () => {
    await runParikshakaDispatch(KSHETRA, TASK, SILPI_OUTPUT);
    expect(mockCommitFile).toHaveBeenCalledTimes(2);
    expect(mockBdCreate).toHaveBeenCalledTimes(2);
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