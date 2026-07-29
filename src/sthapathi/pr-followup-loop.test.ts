import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { PrReview } from './gh.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';

// runPrFollowupLoop drives Silpi/Viharapala and builds context — mock those, but
// keep the real adaptPrReview (pure) from silpi.js. dispatch.js is mocked to
// avoid pulling its heavy graph.
const mockRunSilpi = vi.fn<(...args: unknown[]) => Promise<SilpiOutput>>();
const mockRunViharapala = vi.fn<(...args: unknown[]) => Promise<ViharapalaOutput>>();
const mockBuildContext = vi.fn<(...args: unknown[]) => Promise<object>>();
vi.mock('../agents/silpi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/silpi.js')>();
  return { ...actual, runSilpi: mockRunSilpi };
});
vi.mock('../agents/viharapala.js', () => ({ runViharapala: mockRunViharapala }));
vi.mock('./dispatch.js', () => ({ buildAgentContext: mockBuildContext }));

const mockEmit = vi.fn();
vi.mock('../telemetry/telemetry.js', () => ({ emit: mockEmit }));

const { runPrFollowupLoop } = await import('./pr-followup-loop.js');

const TASK: Task = { id: 'proj-9', slug: 'fix-thing', title: 'Fix thing', status: 'in_progress', priority: 2 };
const REVIEW: PrReview = {
  author: 'human',
  state: 'CHANGES_REQUESTED',
  body: 'needs a null guard',
  submittedAt: '2026-07-29T12:00:00Z',
  comments: [{ author: 'human', body: 'guard this', path: 'src/a.ts', line: 5 }],
};

function kshetra(over: { max?: number; reReview?: boolean } = {}): KshetraConfig {
  return {
    repo: { prFollowup: true, prFollowupMaxRounds: over.max ?? 3, prFollowupReReview: over.reReview ?? true },
  } as unknown as KshetraConfig;
}
function silpi(over: Partial<SilpiOutput> = {}): SilpiOutput {
  return {
    filesChanged: [{ path: 'src/a.ts', diff: '+ guarded' }],
    testFiles: [],
    summary: 'guarded',
    confidenceScore: 90,
    questionsForReviewer: [],
    lintPassed: true,
    testsPassed: true,
    insights: [],
    ...over,
  };
}
const APPROVE: ViharapalaOutput = { verdict: 'APPROVE', overallScore: 90, mustFix: [], suggestions: [], issues: [], insights: [] };
const REJECT: ViharapalaOutput = { verdict: 'REJECT', overallScore: 30, mustFix: ['try again'], suggestions: [], issues: [], insights: [] };
const input = (over: Partial<{ startRound: number; failingChecks: { name: string; summary: string }[] }> = {}) => ({
  review: REVIEW,
  failingChecks: over.failingChecks ?? [],
  startRound: over.startRound ?? 0,
});

beforeEach(() => {
  mockRunSilpi.mockReset();
  mockRunViharapala.mockReset();
  mockBuildContext.mockReset();
  mockEmit.mockReset();
  mockBuildContext.mockResolvedValue({ taskDetails: 'td', kshetra: kshetra(), task: TASK });
});

describe('runPrFollowupLoop', () => {
  it('approves on the first round when the re-review passes', async () => {
    mockRunSilpi.mockResolvedValue(silpi());
    mockRunViharapala.mockResolvedValue(APPROVE);
    const res = await runPrFollowupLoop(TASK, kshetra(), input());
    expect(res.outcome).toBe('approved');
    expect(res.rounds).toBe(1);
    expect(res.output).not.toBeNull();
    expect(mockRunSilpi).toHaveBeenCalledTimes(1);
    expect(mockRunViharapala).toHaveBeenCalledTimes(1);
  });

  it('re-review gate blocks a bad fix, then approves on a later round', async () => {
    mockRunSilpi.mockResolvedValue(silpi());
    mockRunViharapala.mockResolvedValueOnce(REJECT).mockResolvedValueOnce(APPROVE);
    const res = await runPrFollowupLoop(TASK, kshetra({ max: 3 }), input());
    expect(res.outcome).toBe('approved');
    expect(res.rounds).toBe(2);
    expect(mockRunSilpi).toHaveBeenCalledTimes(2);
  });

  it('exhausts the round budget when the re-review keeps rejecting', async () => {
    mockRunSilpi.mockResolvedValue(silpi());
    mockRunViharapala.mockResolvedValue(REJECT);
    const res = await runPrFollowupLoop(TASK, kshetra({ max: 2 }), input());
    expect(res.outcome).toBe('exhausted');
    expect(res.rounds).toBe(2);
    expect(mockRunSilpi).toHaveBeenCalledTimes(2); // respects prFollowupMaxRounds
  });

  it('emits pr_followup_round telemetry once per round that runs', async () => {
    mockRunSilpi.mockResolvedValue(silpi());
    mockRunViharapala.mockResolvedValueOnce(REJECT).mockResolvedValueOnce(APPROVE);
    await runPrFollowupLoop(TASK, kshetra({ max: 3 }), input());
    const rounds = mockEmit.mock.calls.filter(c => c[0] === 'pr_followup_round');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]![1]).toEqual({ round: 1, reReview: true });
    expect(rounds[1]![1]).toEqual({ round: 2, reReview: true });
  });

  it('emits no round telemetry when the budget is already spent (no round runs)', async () => {
    await runPrFollowupLoop(TASK, kshetra({ max: 3 }), input({ startRound: 3 }));
    expect(mockEmit).not.toHaveBeenCalledWith('pr_followup_round', expect.anything());
  });

  it('short-circuits to escalated when Silpi flags a comment escalate', async () => {
    mockRunSilpi.mockResolvedValue(
      silpi({ commentResponses: [{ commentId: 'c0', disposition: 'escalate', reply: 'needs product call' }] }),
    );
    mockRunViharapala.mockResolvedValue(APPROVE);
    const res = await runPrFollowupLoop(TASK, kshetra(), input());
    expect(res.outcome).toBe('escalated');
    expect(res.rounds).toBe(1);
    expect(res.output?.commentResponses?.[0].disposition).toBe('escalate');
    expect(mockRunViharapala).not.toHaveBeenCalled(); // escalate skips re-review
  });

  it('exhausts immediately without running an agent when the budget is already spent', async () => {
    const res = await runPrFollowupLoop(TASK, kshetra({ max: 3 }), input({ startRound: 3 }));
    expect(res.outcome).toBe('exhausted');
    expect(res.output).toBeNull();
    expect(mockRunSilpi).not.toHaveBeenCalled();
  });

  it('skips the re-review gate when prFollowupReReview is false', async () => {
    mockRunSilpi.mockResolvedValue(silpi());
    const res = await runPrFollowupLoop(TASK, kshetra({ reReview: false }), input());
    expect(res.outcome).toBe('approved');
    expect(res.rounds).toBe(1);
    expect(mockRunViharapala).not.toHaveBeenCalled();
  });

  it('passes the adapted human review to Silpi as prFeedback and honours the startRound offset', async () => {
    mockRunSilpi.mockResolvedValue(silpi());
    mockRunViharapala.mockResolvedValue(APPROVE);
    const res = await runPrFollowupLoop(TASK, kshetra({ max: 3 }), input({ startRound: 1, failingChecks: [{ name: 'build', summary: 'red' }] }));
    expect(res.rounds).toBe(2); // startRound 1 → first productive round is 2
    // 6th positional arg to runSilpi is the adapted PrReviewFeedback
    const prFeedbackArg = mockRunSilpi.mock.calls[0][5] as { failingChecks: unknown[]; comments: { id: string }[] };
    expect(prFeedbackArg.failingChecks).toEqual([{ name: 'build', summary: 'red' }]);
    expect(prFeedbackArg.comments[0].id).toBe('c0');
  });
});
