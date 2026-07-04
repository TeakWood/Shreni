import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockBdPrime = vi.fn<() => Promise<string>>();
const mockBdShow = vi.fn<(id: string) => Promise<string>>();
const mockBdAddNote = vi.fn<() => Promise<string>>();
const mockBdRemember = vi.fn<() => Promise<string>>();
const mockBdFlag = vi.fn<() => Promise<string>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({
    prime: mockBdPrime,
    show: mockBdShow,
    addNote: mockBdAddNote,
    remember: mockBdRemember,
    flag: mockBdFlag,
  })),
}));

const mockRunSilpi = vi.fn<() => Promise<SilpiOutput>>();
vi.mock('../agents/silpi.js', () => ({ runSilpi: mockRunSilpi }));

const mockRunViharapala = vi.fn<() => Promise<ViharapalaOutput>>();
vi.mock('../agents/viharapala.js', () => ({ runViharapala: mockRunViharapala }));

const mockCreateTaskBranch = vi.fn<() => Promise<string>>();
vi.mock('./branch.js', () => ({
  createTaskBranch: mockCreateTaskBranch,
  branchName: vi.fn((task: { id: string; slug: string }) => `bead-${task.id}/${task.slug}`),
}));

const mockSquashMergeAndClose = vi.fn<() => Promise<void>>();
vi.mock('./merge.js', () => ({ squashMergeAndClose: mockSquashMergeAndClose }));

const mockIsHealthBead = vi.fn<(t: Task) => boolean>();
const mockMeasureHealth = vi.fn<() => Promise<{ green: boolean; failCount: number; baseline: number; sha: string }>>();
vi.mock('./health.js', () => ({
  isHealthBead: (t: Task) => mockIsHealthBead(t),
  measureHealth: () => mockMeasureHealth(),
}));

const mockRunLintGate = vi.fn<() => Promise<{ passed: boolean; skipped: boolean; raw: string }>>();
vi.mock('./lint.js', () => ({ runLintGate: () => mockRunLintGate() }));

const mockSetHealthBaseline = vi.fn<() => void>();
const mockRecordProgress = vi.fn<() => void>();
vi.mock('../kshetra/state.js', () => ({
  setHealthBaseline: () => mockSetHealthBaseline(),
  recordProgress: () => mockRecordProgress(),
}));

class FakeOffBranchError extends Error {
  constructor(message: string, public readonly detail: { branch: string; expectedMain: string; actualHead: string; actualMain: string }) {
    super(message);
    this.name = 'OffBranchError';
  }
}
const mockAssertOnBranch = vi.fn<() => Promise<void>>();
const mockRecoverOffBranch = vi.fn<() => Promise<string | null>>();
vi.mock('./guard.js', () => ({
  captureGuard: vi.fn(async () => ({ branch: 'bead-proj-42/fix-auth', mainSha: 'main-sha' })),
  assertOnBranch: () => mockAssertOnBranch(),
  recoverOffBranch: () => mockRecoverOffBranch(),
  OffBranchError: FakeOffBranchError,
}));

// fs mock to avoid real disk reads
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

const { buildAgentContext, runSilpiViharapalaLoop } = await import('./dispatch.js');
const { AgentAbortedError } = await import('./errors.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: {
    path: '/projects/myapp',
    remote: 'git@github.com:TeakWood/myapp.git',
    mainBranch: 'main',
    branchPattern: 'bead-{id}/{slug}',
  },
  beads: {
    path: '/projects/myapp-beads',
    remote: 'git@github.com:TeakWood/myapp-beads.git',
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
  mockBdFlag.mockResolvedValue('');
  mockRunSilpi.mockResolvedValue(SILPI_PASS);
  mockRunViharapala.mockResolvedValue(VIHARAPALA_APPROVE);
  mockCreateTaskBranch.mockResolvedValue('bead-proj-42/fix-auth');
  mockSquashMergeAndClose.mockResolvedValue(undefined);
  mockIsHealthBead.mockReturnValue(false);
  mockMeasureHealth.mockResolvedValue({ green: true, failCount: 0, baseline: 0, sha: 'sha' });
  mockRunLintGate.mockResolvedValue({ passed: true, skipped: false, raw: '' });
  mockAssertOnBranch.mockResolvedValue(undefined);
  mockRecoverOffBranch.mockResolvedValue('shreni-salvage/proj-42');
});

const HEALTH_TASK: Task = {
  id: 'proj-health',
  slug: 'restore-green',
  title: '[shreni-health] Restore green test suite',
  status: 'pending',
  priority: 0,
};

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

  it('returns empty universalSkills when SKILLS.md is missing', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.universalSkills).toBe('');
  });

  it('includes kshetra and task in context', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.kshetra).toBe(KSHETRA);
    expect(ctx.task).toBe(TASK);
  });

  // Native execution (the agent-execution design §3.1): the provider CLI loads the
  // repo's CLAUDE.md, per-dir CLAUDE.md, and the conventions docs itself, so
  // buildAgentContext must NOT read them (no double-load). Only ~/.shreni skills
  // (universalSkills), which have no repo-native home, are still read.
  it('does not read the repo CLAUDE.md or conventions docs (loaded natively)', async () => {
    const { readFile } = await import('fs/promises');
    const mockReadFile = vi.mocked(readFile);
    mockReadFile.mockClear();
    const kshetra = { ...KSHETRA, conventions: { styleGuide: '.shreni/style-guide.md', architecture: '.shreni/arch.md' } };
    await buildAgentContext(kshetra, TASK);
    const readPaths = mockReadFile.mock.calls.map(c => String(c[0]));
    expect(readPaths.some(p => p.endsWith('CLAUDE.md'))).toBe(false);
    expect(readPaths.some(p => p.includes('style-guide.md'))).toBe(false);
    expect(readPaths.some(p => p.includes('arch.md'))).toBe(false);
  });

  it('loads the reviewer-only reviewGuide when conventions.reviewGuide is set', async () => {
    const { readFile } = await import('fs/promises');
    const mockReadFile = vi.mocked(readFile);
    mockReadFile.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('review-guide.md')) {
        return Promise.resolve('reviewer rubric') as ReturnType<typeof readFile>;
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) as ReturnType<typeof readFile>;
    });
    const kshetra = { ...KSHETRA, conventions: { reviewGuide: '.shreni/review-guide.md' } };
    const ctx = await buildAgentContext(kshetra, TASK);
    expect(ctx.reviewGuide).toBe('reviewer rubric');
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('leaves reviewGuide empty when conventions.reviewGuide is unset', async () => {
    const ctx = await buildAgentContext(KSHETRA, TASK);
    expect(ctx.reviewGuide).toBe('');
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

  it('records forward progress on claim and on approval (watchdog stall track)', async () => {
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    // task_claimed + the approved task_done both stamp progress / reset the stall track
    expect(mockRecordProgress).toHaveBeenCalledTimes(2);
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

  it('blocked message attributes to the reviewer when Viharapala kept rejecting', async () => {
    mockRunViharapala.mockResolvedValue(VIHARAPALA_REJECT);
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining('Viharapala kept rejecting'));
  });

  it('blocked message attributes to the task when its own tests kept failing', async () => {
    mockRunSilpi.mockResolvedValue(SILPI_FAIL);
    mockRunLintGate.mockResolvedValue({ passed: false, skipped: false, raw: 'lint errors' });
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunViharapala).not.toHaveBeenCalled();
    expect(mockBdFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining("own tests/lint kept failing"));
    expect(result.note).toContain('tests');
  });

  // ── off-branch guardrail ──────────────────────────────

  it('aborts before review when the agent leaves the bead branch', async () => {
    mockAssertOnBranch.mockRejectedValue(
      new FakeOffBranchError('HEAD is on "main", expected bead branch "bead-proj-42/fix-auth"', {
        branch: 'bead-proj-42/fix-auth', expectedMain: 'main-sha', actualHead: 'main', actualMain: 'stray',
      }),
    );
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(false);
    expect(result.note).toContain('off-branch');
    expect(mockRunViharapala).not.toHaveBeenCalled();   // never reaches review
    expect(mockSquashMergeAndClose).not.toHaveBeenCalled();
  });

  it('recovers and flags the bead with the salvage ref when work lands on main', async () => {
    mockAssertOnBranch.mockRejectedValue(
      new FakeOffBranchError('main moved from aaaaaaaa to bbbbbbbb outside the squash-merge flow', {
        branch: 'bead-proj-42/fix-auth', expectedMain: 'aaaa', actualHead: 'bead-proj-42/fix-auth', actualMain: 'bbbb',
      }),
    );
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRecoverOffBranch).toHaveBeenCalledTimes(1);
    expect(mockBdFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining('shreni-salvage/proj-42'));
    expect(mockBdFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining('main restored to origin'));
  });

  it('rethrows non-OffBranch errors from the guard', async () => {
    mockAssertOnBranch.mockRejectedValue(new Error('git exploded'));
    await expect(runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth')).rejects.toThrow('git exploded');
  });

  it('skips Viharapala when the lint gate fails and re-dispatches Silpi', async () => {
    mockRunSilpi
      .mockResolvedValueOnce(SILPI_FAIL)
      .mockResolvedValueOnce(SILPI_PASS);
    mockRunLintGate
      .mockResolvedValueOnce({ passed: false, skipped: false, raw: 'lint errors' })
      .mockResolvedValue({ passed: true, skipped: false, raw: '' });
    mockRunViharapala.mockResolvedValueOnce(VIHARAPALA_APPROVE);
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunViharapala).toHaveBeenCalledOnce();
    expect(result.approved).toBe(true);
  });

  it('adds lint/tests failed note when the enforced lint gate fails', async () => {
    mockRunSilpi
      .mockResolvedValueOnce(SILPI_PASS)
      .mockResolvedValueOnce(SILPI_PASS);
    mockRunLintGate
      .mockResolvedValueOnce({ passed: false, skipped: false, raw: 'lint errors' })
      .mockResolvedValue({ passed: true, skipped: false, raw: '' });
    mockRunViharapala.mockResolvedValueOnce(VIHARAPALA_APPROVE);
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockBdAddNote).toHaveBeenCalledWith('proj-42', expect.stringContaining('lint/tests failed'));
  });

  it('REJECTS on a failing lint gate even when Silpi self-reports lintPassed=true', async () => {
    // The enforced gate ignores the self-report (the toolchain design §3.3): SILPI_PASS
    // has lintPassed=true, but a red lint gate must still block review.
    mockRunSilpi.mockResolvedValue(SILPI_PASS);
    mockRunLintGate.mockResolvedValue({ passed: false, skipped: false, raw: 'lint errors' });
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunViharapala).not.toHaveBeenCalled();
    expect(result.approved).toBe(false);
  });

  it('proceeds to review when there is no lint gate (skipped) and health is green', async () => {
    mockRunSilpi.mockResolvedValue(SILPI_PASS);
    mockRunLintGate.mockResolvedValue({ passed: true, skipped: true, raw: '(skipped)' });
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(mockRunViharapala).toHaveBeenCalledOnce();
    expect(result.approved).toBe(true);
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

  // ── baseline-aware test gate ─────────────────────────────

  it('merges a clean diff when failCount is within the health baseline', async () => {
    // Live repro (myapp-le3y): a clean migration with N pre-existing unrelated
    // failures and baseline=N. The suite is "green enough", so the task must not
    // be auto-rejected. Silpi's own testsPassed boolean must NOT be the gate, so
    // we set it false to prove health.green is what drives the decision.
    mockRunSilpi.mockResolvedValue({ ...SILPI_PASS, testsPassed: false });
    mockMeasureHealth.mockResolvedValue({ green: true, failCount: 28, baseline: 28, sha: 's' });
    const result = await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(true);
    expect(mockRunViharapala).toHaveBeenCalledOnce(); // review path reached, not wedged
    expect(mockSquashMergeAndClose).toHaveBeenCalledOnce();
  });

  it('still rejects on tests when the task adds failures beyond the baseline', async () => {
    const kshetra = { ...KSHETRA, agents: { ...KSHETRA.agents, maxRoundsPerBead: 1 } };
    // Agent self-reports passing, but the suite now has MORE failures than the
    // accepted baseline — a regression the task introduced. Must not slip through.
    mockRunSilpi.mockResolvedValue({ ...SILPI_PASS, testsPassed: true });
    mockMeasureHealth.mockResolvedValue({ green: false, failCount: 29, baseline: 28, sha: 's' });
    const result = await runSilpiViharapalaLoop(kshetra, TASK, 'bead-proj-42/fix-auth');
    expect(result.approved).toBe(false);
    expect(mockRunViharapala).not.toHaveBeenCalled(); // rejected on tests, never reaches review
    expect(result.note).toContain('tests');
    expect(mockBdFlag).toHaveBeenCalledWith('proj-42', expect.stringContaining("own tests/lint kept failing"));
  });

  // ── self-heal abort ──────────────────────────────────────

  it('throws AgentAbortedError and dispatches no agent when the signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth', controller.signal),
    ).rejects.toBeInstanceOf(AgentAbortedError);
    expect(mockRunSilpi).not.toHaveBeenCalled();
  });

  it('forwards the abort signal to Silpi and Viharapala', async () => {
    const controller = new AbortController();
    await runSilpiViharapalaLoop(KSHETRA, TASK, 'bead-proj-42/fix-auth', controller.signal);
    expect(mockRunSilpi).toHaveBeenCalledWith(
      expect.anything(), 1, null, 'bead-proj-42/fix-auth', controller.signal,
    );
    expect(mockRunViharapala).toHaveBeenCalledWith(
      expect.anything(), SILPI_PASS, 1, expect.anything(), 'bead-proj-42/fix-auth', controller.signal,
    );
  });
});
// ── health repair loop ──────────────────────────────────────────────────────

describe('runSilpiViharapalaLoop — health repair beads', () => {
  beforeEach(() => {
    mockIsHealthBead.mockImplementation((t: Task) => t.title.startsWith('[shreni-health]'));
  });

  it('merges and resets the baseline when the suite reaches green', async () => {
    // pre-repair measure (red), then post-Silpi measure (green)
    mockMeasureHealth
      .mockResolvedValueOnce({ green: false, failCount: 3, baseline: 0, sha: 's' })
      .mockResolvedValueOnce({ green: true, failCount: 0, baseline: 0, sha: 's' });
    const result = await runSilpiViharapalaLoop(KSHETRA, HEALTH_TASK, 'b');
    expect(result.approved).toBe(true);
    expect(mockSquashMergeAndClose).toHaveBeenCalledOnce();
    expect(mockSetHealthBaseline).toHaveBeenCalled();
    expect(mockRunViharapala).not.toHaveBeenCalled();
  });

  it('keeps going while failures strictly decrease', async () => {
    mockMeasureHealth
      .mockResolvedValueOnce({ green: false, failCount: 5, baseline: 0, sha: 's' }) // start
      .mockResolvedValueOnce({ green: false, failCount: 3, baseline: 0, sha: 's' }) // r1 progress
      .mockResolvedValueOnce({ green: true, failCount: 0, baseline: 0, sha: 's' }); // r2 green
    const result = await runSilpiViharapalaLoop(KSHETRA, HEALTH_TASK, 'b');
    expect(result.approved).toBe(true);
    expect(mockRunSilpi).toHaveBeenCalledTimes(2);
  });

  it('quarantines remaining failures and flags for a human when it stalls', async () => {
    mockMeasureHealth.mockResolvedValue({ green: false, failCount: 4, baseline: 0, sha: 's' });
    const result = await runSilpiViharapalaLoop(KSHETRA, HEALTH_TASK, 'b');
    expect(result.approved).toBe(false);
    expect(mockSquashMergeAndClose).not.toHaveBeenCalled();
    expect(mockSetHealthBaseline).toHaveBeenCalled();
    expect(mockBdFlag).toHaveBeenCalledWith('proj-health', expect.stringContaining('[needs-human]'));
  });
});
