import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockBdPrime = vi.fn<() => Promise<string>>();
const mockBdShow = vi.fn<(id: string) => Promise<string>>();
const mockBdAddNote = vi.fn<() => Promise<string>>();
const mockBdRemember = vi.fn<() => Promise<string>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({
    prime: mockBdPrime,
    show: mockBdShow,
    addNote: mockBdAddNote,
    remember: mockBdRemember,
  })),
}));

const mockRunSilpi = vi.fn<() => Promise<SilpiOutput>>();
vi.mock('../agents/silpi.js', () => ({ runSilpi: mockRunSilpi }));

const mockRunViharapala = vi.fn<() => Promise<ViharapalaOutput>>();
vi.mock('../agents/viharapala.js', () => ({ runViharapala: mockRunViharapala }));

// fs mock to avoid real disk reads
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

const { buildAgentContext, runSilpiViharapalaLoop } = await import('./dispatch.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: {
    path: '/projects/sishya',
    remote: 'git@github.com:TeakWood/sishya.git',
    mainBranch: 'main',
    branchPattern: 'bead-{id}/{slug}',
  },
  beads: {
    path: '/projects/sishya-beads',
    remote: 'git@github.com:TeakWood/sishya-beads.git',
    mode: 'embedded',
  },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = {
  id: 'proj-42',
  slug: 'fix-auth',
  title: 'Fix auth',
  description: 'Auth is broken',
  status: 'pending',
  priority: 2,
};

const SILPI_PASS: SilpiOutput = {
  filesChanged: [{ path: 'src/auth.ts', diff: '+ fix' }],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth',
  confidenceScore: 90,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: ['insight A'],
};

const SILPI_FAIL: SilpiOutput = {
  ...SILPI_PASS,
  lintPassed: false,
  testsPassed: false,
  insights: [],
};

const VIHARAPALA_APPROVE: ViharapalaOutput = {
  verdict: 'APPROVE',
  overallScore: 92,
  mustFix: [],
  suggestions: [],
  issues: [],
  insights: ['insight B'],
};

const VIHARAPALA_REJECT: ViharapalaOutput = {
  verdict: 'REJECT',
  overallScore: 50,
  mustFix: ['add error handling'],
  suggestions: [],
  issues: [],
  insights: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBdPrime.mockResolvedValue('prime output');
  mockBdShow.mockResolvedValue('task details output');
  mockBdAddNote.mockResolvedValue('');
  mockBdRemember.mockResolvedValue('');
  mockRunSilpi.mockResolvedValue(SILPI_PASS);
  mockRunViharapala.mockResolvedValue(VIHARAPALA_APPROVE);
});

// ── buildAgentContext ─────────────────────────────────────────────────────────

describe('buildAgentContext', () => {
  it('calls bd prime and bd show', async () => {
    await buildAgentContext(KSHETRA, TASK);
    expect(mockBdPrime).toHaveBeenCalledOnce();
    expect(mockBdShow).toHaveBeenCalledWith('proj-42');
  });

  it('injects bd prime output as projectMemory', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.projectMemory).toBe('prime output');
  });

  it('injects bd show output as taskDetails', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.taskDetails).toBe('task details output');
  });

  it('sets ragChunks to empty string (stub until Phase 9)', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.ragChunks).toBe('');
  });

  it('returns empty strings for missing files', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.projectSkills).toBe('');
    expect(ctx.universalSkills).toBe('');
    expect(ctx.conventions).toBe('');
    expect(ctx.architecture).toBe('');
  });

  it('includes kshetra and task in context', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.kshetra).toBe(KSHETRA);
    expect(ctx.task).toBe(TASK);
  });

  it('reads conventions file when styleGuide is configured', async () => {
    const { readFile } = await import('fs/promises');
    const mockReadFile = vi.mocked(readFile);
    mockReadFile.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('style-guide.md')) {
        return Promise.resolve('no magic numbers') as ReturnType<typeof readFile>;
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) as ReturnType<typeof readFile>;
    });
    const kshetra = { ...KSHETRA, conventions: { styleGuide: '.shreni/style-guide.md' } };
    const ctx = await buildAgentContext(kshetra, TASK);
    expect(ctx.conventions).toBe('no magic numbers');
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });
});

// ── runSilpiViharapalaLoop ────────────────────────────────────────────────────

describe('runSilpiViharapalaLoop', () => {
  it('returns approved=true when Viharapala approves on round 1', async () => {
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(true);
    expect(result.note).toContain('round 1');
  });

  it('calls Silpi once and Viharapala once on first-round approval', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunSilpi).toHaveBeenCalledOnce();
    expect(mockRunViharapala).toHaveBeenCalledOnce();
  });

  it('passes null feedback to Silpi on round 1', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    const [, , feedback] = mockRunSilpi.mock.calls[0] as unknown as [unknown, number, unknown];
    expect(feedback).toBeNull();
  });

  it('re-dispatches Silpi with REJECT feedback on round 2', async () => {
    mockRunViharapala
      .mockResolvedValueOnce(VIHARAPALA_REJECT)
      .mockResolvedValueOnce(VIHARAPALA_APPROVE);
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(true);
    expect(mockRunSilpi).toHaveBeenCalledTimes(2);
    const [, round2, feedback] = mockRunSilpi.mock.calls[1] as unknown as [unknown, number, ViharapalaOutput];
    expect(round2).toBe(2);
    expect(feedback?.verdict).toBe('REJECT');
  });

  it('passes mustFix list to Silpi after REJECT', async () => {
    mockRunViharapala
      .mockResolvedValueOnce(VIHARAPALA_REJECT)
      .mockResolvedValueOnce(VIHARAPALA_APPROVE);
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    const [, , feedback] = mockRunSilpi.mock.calls[1] as unknown as [unknown, number, ViharapalaOutput];
    expect(feedback?.mustFix).toEqual(['add error handling']);
  });

  it('returns approved=false after max rounds are exhausted', async () => {
    mockRunViharapala.mockResolvedValue(VIHARAPALA_REJECT);
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(false);
    expect(result.note).toContain('3 rounds');
    expect(mockRunSilpi).toHaveBeenCalledTimes(3);
  });

  it('blocks after maxRoundsPerBead without calling Viharapala extra times', async () => {
    mockRunViharapala.mockResolvedValue(VIHARAPALA_REJECT);
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunViharapala).toHaveBeenCalledTimes(3);
  });

  it('skips Viharapala when lint/tests fail and re-dispatches Silpi', async () => {
    mockRunSilpi
      .mockResolvedValueOnce(SILPI_FAIL)
      .mockResolvedValueOnce(SILPI_PASS);
    mockRunViharapala.mockResolvedValueOnce(VIHARAPALA_APPROVE);
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunViharapala).toHaveBeenCalledOnce();
    expect(result.approved).toBe(true);
  });

  it('adds lint/tests failed note when Silpi self-reports failure', async () => {
    mockRunSilpi
      .mockResolvedValueOnce(SILPI_FAIL)
      .mockResolvedValueOnce(SILPI_PASS);
    mockRunViharapala.mockResolvedValueOnce(VIHARAPALA_APPROVE);
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdAddNote).toHaveBeenCalledWith('proj-42', expect.stringContaining('lint/tests failed'));
  });

  it('adds "submitted for review" note before dispatching Viharapala', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdAddNote).toHaveBeenCalledWith('proj-42', expect.stringContaining('submitted for review'));
  });

  it('adds verdict note after Viharapala responds', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdAddNote).toHaveBeenCalledWith('proj-42', expect.stringContaining('APPROVE'));
  });

  it('calls bd remember for each Silpi insight', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdRemember).toHaveBeenCalledWith('insight A');
  });

  it('calls bd remember for each Viharapala insight', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdRemember).toHaveBeenCalledWith('insight B');
  });

  it('respects custom maxRoundsPerBead', async () => {
    const kshetra = { ...KSHETRA, agents: { ...KSHETRA.agents, maxRoundsPerBead: 1 } };
    mockRunViharapala.mockResolvedValue(VIHARAPALA_REJECT);
    const result = await runSilpiViharapalaLoop(kshetra, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(false);
    expect(mockRunSilpi).toHaveBeenCalledOnce();
  });
});