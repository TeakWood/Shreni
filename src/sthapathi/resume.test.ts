/**
 * Integration test: a WIP bead resumed after a worker restart
 * re-enters the real Silpi↔Viharapala loop WITHOUT running the pickup health gate.
 *
 * This is the end-to-end proof of the design guarantee —
 * "WIP resumes via the recovery path, bypassing the gate" — which was previously
 * correct only by construction. We drive scheduleResume() with the REAL
 * runSilpiViharapalaLoop (only the agents / git / beads boundaries are mocked) and
 * assert checkHealth() (the pickup-only gate) is never invoked on the resume path,
 * while measureHealth() (the in-loop test gate) is. See
 * the Sthapathi workflow design §4.2.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockBdPrime = vi.fn<() => Promise<string>>();
const mockBdShow = vi.fn<() => Promise<string>>();
const mockBdAddNote = vi.fn<() => Promise<string>>();
const mockBdRemember = vi.fn<() => Promise<string>>();
const mockBdFlag = vi.fn<() => Promise<string>>();
const mockBdClaim = vi.fn<() => Promise<string>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({
    prime: mockBdPrime,
    show: mockBdShow,
    addNote: mockBdAddNote,
    remember: mockBdRemember,
    flag: mockBdFlag,
    claim: mockBdClaim,
  })),
  syncBeads: vi.fn(async () => {}),
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

// Both health functions are spied so we can prove which one the resume path hits.
// checkHealth = the pickup-only gate (must NOT run); measureHealth = the in-loop
// test gate (runs every round).
const mockCheckHealth = vi.fn<() => Promise<{ green: boolean; failCount: number; baseline: number; sha: string }>>();
const mockMeasureHealth = vi.fn<() => Promise<{ green: boolean; failCount: number; baseline: number; sha: string }>>();
const mockIsHealthBead = vi.fn<(t: Task) => boolean>();
vi.mock('./health.js', () => ({
  checkHealth: () => mockCheckHealth(),
  measureHealth: () => mockMeasureHealth(),
  isHealthBead: (t: Task) => mockIsHealthBead(t),
}));

// Enforced lint gate: default to a green skip so the resume loop isn't blocked
// by a real linter subprocess.
const mockRunLintGate = vi.fn<() => Promise<{ passed: boolean; skipped: boolean; raw: string }>>();
vi.mock('./lint.js', () => ({ runLintGate: () => mockRunLintGate() }));

const mockSetHealthBaseline = vi.fn<() => void>();
const mockRecordProgress = vi.fn<() => void>();
vi.mock('../kshetra/state.js', () => ({
  setHealthBaseline: () => mockSetHealthBaseline(),
  recordProgress: () => mockRecordProgress(),
  recordBeadAttempt: vi.fn(() => 1),
}));

vi.mock('./guard.js', () => ({
  captureGuard: vi.fn(async () => ({ branch: 'bead-proj-42/fix-auth', mainSha: 'main-sha' })),
  assertOnBranch: vi.fn(async () => {}),
  recoverOffBranch: vi.fn(async () => null),
  OffBranchError: class OffBranchError extends Error {},
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

vi.mock('./git.js', () => ({ git: vi.fn(() => ({})) }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { scheduleResume } = await import('./recover.js');
const { runSilpiViharapalaLoop } = await import('./dispatch.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

const WIP_TASK: Task = {
  id: 'proj-42',
  slug: 'fix-auth',
  title: 'Fix auth',
  description: 'Auth is broken',
  status: 'in_progress',
  priority: 2,
};

const HEALTH_TASK: Task = {
  id: 'proj-health',
  slug: 'restore-green',
  title: '[shreni-health] Restore green test suite',
  status: 'in_progress',
  priority: 0,
};

const SILPI_PASS: SilpiOutput = {
  filesChanged: [{ path: 'src/auth.ts', diff: '+ fix' }],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth',
  confidenceScore: 90,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: [],
};

const VIHARAPALA_APPROVE: ViharapalaOutput = {
  verdict: 'APPROVE',
  overallScore: 92,
  mustFix: [],
  suggestions: [],
  issues: [],
  insights: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBdPrime.mockResolvedValue('prime');
  mockBdShow.mockResolvedValue('details');
  mockBdAddNote.mockResolvedValue('');
  mockBdRemember.mockResolvedValue('');
  mockBdFlag.mockResolvedValue('');
  mockBdClaim.mockResolvedValue('');
  mockRunSilpi.mockResolvedValue(SILPI_PASS);
  mockRunViharapala.mockResolvedValue(VIHARAPALA_APPROVE);
  mockCreateTaskBranch.mockResolvedValue('bead-proj-42/fix-auth');
  mockSquashMergeAndClose.mockResolvedValue(undefined);
  mockCheckHealth.mockResolvedValue({ green: true, failCount: 0, baseline: 0, sha: 'sha' });
  mockMeasureHealth.mockResolvedValue({ green: true, failCount: 0, baseline: 0, sha: 'sha' });
  mockRunLintGate.mockResolvedValue({ passed: true, skipped: false, raw: '' });
  mockIsHealthBead.mockImplementation((t: Task) => t.title.startsWith('[shreni-health]'));
});

describe('scheduleResume → runSilpiViharapalaLoop (WIP recovery bypasses the health gate)', () => {
  it('completes the bead WITHOUT ever calling the pickup health gate (checkHealth)', async () => {
    const result = await scheduleResume(KSHETRA, WIP_TASK, runSilpiViharapalaLoop);

    expect(result.approved).toBe(true);
    // The crux: the pickup-only gate must never run on the resume path.
    expect(mockCheckHealth).not.toHaveBeenCalled();
    // ...but the in-loop test gate still runs, so a resumed bead can't merge red.
    expect(mockMeasureHealth).toHaveBeenCalled();
    // And it really went through the agent loop + merge.
    expect(mockRunSilpi).toHaveBeenCalled();
    expect(mockRunViharapala).toHaveBeenCalled();
    expect(mockSquashMergeAndClose).toHaveBeenCalledOnce();
  });

  it('re-claims the in-flight bead instead of going through preFlightCheck', async () => {
    await scheduleResume(KSHETRA, WIP_TASK, runSilpiViharapalaLoop);
    expect(mockBdClaim).toHaveBeenCalledWith('proj-42');
  });

  it('resumes a [shreni-health] repair bead via the repair loop, still no health gate', async () => {
    // Pre-repair measure (red) then post-Silpi measure (green) — repair-loop shape.
    mockMeasureHealth
      .mockResolvedValueOnce({ green: false, failCount: 3, baseline: 0, sha: 's' })
      .mockResolvedValueOnce({ green: true, failCount: 0, baseline: 0, sha: 's' });

    const result = await scheduleResume(KSHETRA, HEALTH_TASK, runSilpiViharapalaLoop);

    expect(result.approved).toBe(true);
    expect(mockCheckHealth).not.toHaveBeenCalled();
    expect(mockRunViharapala).not.toHaveBeenCalled(); // repair loop has no reviewer
    expect(mockSquashMergeAndClose).toHaveBeenCalledOnce();
  });
});