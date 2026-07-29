import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { PrStatus, PrReview, PrCheck, PrCommit } from './gh.js';
import type { Task, SilpiOutput, ViharapalaOutput } from './types.js';

// bd is mocked so readWatermark can be driven from a fixture `bd show --json`.
const mockShow = vi.fn<() => Promise<string>>();
const mockAddNote = vi.fn<() => Promise<string>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ show: mockShow, addNote: mockAddNote })),
}));

// runPrFollowupLoop drives Silpi/Viharapala and builds context — mock those, but
// keep the real adaptPrReview (pure) from silpi.js.
const mockRunSilpi = vi.fn<(...args: unknown[]) => Promise<SilpiOutput>>();
const mockRunViharapala = vi.fn<(...args: unknown[]) => Promise<ViharapalaOutput>>();
const mockBuildContext = vi.fn<(...args: unknown[]) => Promise<object>>();
vi.mock('../agents/silpi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/silpi.js')>();
  return { ...actual, runSilpi: mockRunSilpi };
});
vi.mock('../agents/viharapala.js', () => ({ runViharapala: mockRunViharapala }));
vi.mock('./dispatch.js', () => ({ buildAgentContext: mockBuildContext }));

const {
  resolvePrFollowup,
  parseWatermark,
  formatWatermark,
  readWatermark,
  writeWatermark,
  detectPrFeedback,
  runPrFollowupLoop,
  PR_NEEDS_FOLLOWUP_LABEL,
} = await import('./pr-followup.js');

const KSHETRA = { repo: { prFollowup: true } } as unknown as KshetraConfig;

function status(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: 'OPEN',
    url: 'https://github.com/TeakWood/myapp/pull/1',
    reviews: [],
    checks: [],
    commits: [],
    ...over,
  };
}
function review(over: Partial<PrReview> = {}): PrReview {
  return { author: 'human', state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-07-29T12:00:00Z', comments: [], ...over };
}
function check(over: Partial<PrCheck> = {}): PrCheck {
  return { name: 'build', conclusion: 'FAILURE', ...over };
}
function commit(over: Partial<PrCommit> = {}): PrCommit {
  return { sha: 'aaa', author: 'shreni-bot', ...over };
}

const SELF = ['shreni-bot'];

beforeEach(() => {
  mockShow.mockReset();
  mockAddNote.mockReset();
  mockRunSilpi.mockReset();
  mockRunViharapala.mockReset();
  mockBuildContext.mockReset();
  delete process.env.SHRENI_PR_FOLLOWUP;
});
afterEach(() => {
  delete process.env.SHRENI_PR_FOLLOWUP;
});

describe('resolvePrFollowup', () => {
  it('is on by default when repo.prFollowup is true', () => {
    expect(resolvePrFollowup(KSHETRA)).toBe(true);
  });
  it('SHRENI_PR_FOLLOWUP=off kills it regardless of config', () => {
    process.env.SHRENI_PR_FOLLOWUP = 'off';
    expect(resolvePrFollowup(KSHETRA)).toBe(false);
  });
  it('respects repo.prFollowup=false', () => {
    expect(resolvePrFollowup({ repo: { prFollowup: false } } as unknown as KshetraConfig)).toBe(false);
  });
});

describe('watermark parse/format', () => {
  it('round-trips a watermark through format→parse', () => {
    const w = { head: 'abc123', round: 2, at: '2026-07-29T10:00:00Z' };
    expect(parseWatermark(formatWatermark(w))).toEqual(w);
  });
  it('zeroes a watermark when notes are empty/absent', () => {
    expect(parseWatermark(undefined)).toEqual({ head: null, round: 0, at: null });
    expect(parseWatermark('some unrelated note')).toEqual({ head: null, round: 0, at: null });
  });
  it('takes the LAST occurrence of each key from an accumulated notes blob', () => {
    const notes = [
      'PR opened (awaiting merge): https://…',
      formatWatermark({ head: 'old111', round: 1, at: '2026-07-29T10:00:00Z' }),
      'reviewer pushed a fix',
      formatWatermark({ head: 'new222', round: 3, at: '2026-07-29T14:00:00Z' }),
    ].join('\n');
    expect(parseWatermark(notes)).toEqual({ head: 'new222', round: 3, at: '2026-07-29T14:00:00Z' });
  });
});

describe('readWatermark / writeWatermark', () => {
  it('reads the watermark from bd show --json notes', async () => {
    mockShow.mockResolvedValue(
      JSON.stringify({ id: 'b1', notes: formatWatermark({ head: 'h1', round: 2, at: '2026-07-29T09:00:00Z' }) }),
    );
    expect(await readWatermark(KSHETRA, 'b1')).toEqual({ head: 'h1', round: 2, at: '2026-07-29T09:00:00Z' });
  });
  it('tolerates a bd show that returns a JSON array', async () => {
    mockShow.mockResolvedValue(JSON.stringify([{ id: 'b1', notes: 'pr-followup-head:zz pr-followup-round:0 pr-followup-at:t' }]));
    expect((await readWatermark(KSHETRA, 'b1')).head).toBe('zz');
  });
  it('returns a zeroed watermark when bd show fails or has no notes', async () => {
    mockShow.mockRejectedValue(new Error('bd unavailable'));
    expect(await readWatermark(KSHETRA, 'b1')).toEqual({ head: null, round: 0, at: null });
    mockShow.mockResolvedValue(JSON.stringify({ id: 'b1' }));
    expect(await readWatermark(KSHETRA, 'b1')).toEqual({ head: null, round: 0, at: null });
  });
  it('writeWatermark appends a formatted note', async () => {
    mockAddNote.mockResolvedValue('ok');
    await writeWatermark(KSHETRA, 'b1', { head: 'h9', round: 1, at: '2026-07-29T15:00:00Z' });
    expect(mockAddNote).toHaveBeenCalledWith('b1', 'pr-followup-head:h9 pr-followup-round:1 pr-followup-at:2026-07-29T15:00:00Z');
  });
});

describe('detectPrFeedback', () => {
  const REQUIRED = ['build'];

  it('returns null when there is no unaddressed feedback', () => {
    const fb = detectPrFeedback({
      status: status({ reviews: [review({ state: 'APPROVED' })], checks: [check({ conclusion: 'SUCCESS' })] }),
      watermark: { head: 'aaa', round: 0, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb).toBeNull();
  });

  it('triggers on a CHANGES_REQUESTED review newer than the watermark and resets the round', () => {
    const fb = detectPrFeedback({
      status: status({ reviews: [review({ submittedAt: '2026-07-29T12:00:00Z' })] }),
      watermark: { head: 'aaa', round: 2, at: '2026-07-29T10:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb?.triggers).toEqual(['changes_requested']);
    expect(fb?.changesRequested).toHaveLength(1);
    expect(fb?.round).toBe(0); // new human review → fresh event
  });

  it('does NOT re-trigger the same review after a follow-up push (review older than watermark)', () => {
    const fb = detectPrFeedback({
      status: status({ reviews: [review({ submittedAt: '2026-07-29T10:00:00Z' })] }),
      watermark: { head: 'bbb', round: 1, at: '2026-07-29T11:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb).toBeNull();
  });

  it('triggers on a failing required check but ignores an advisory red', () => {
    const required = detectPrFeedback({
      status: status({ checks: [check({ name: 'build', conclusion: 'FAILURE' })] }),
      watermark: { head: 'aaa', round: 0, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(required?.triggers).toEqual(['failing_check']);

    const advisory = detectPrFeedback({
      status: status({ checks: [check({ name: 'coverage', conclusion: 'FAILURE' })] }),
      watermark: { head: 'aaa', round: 0, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED, // 'coverage' not required
    });
    expect(advisory).toBeNull();
  });

  it('ignores a pending required check (null conclusion)', () => {
    const fb = detectPrFeedback({
      status: status({ checks: [check({ name: 'build', conclusion: null })] }),
      watermark: { head: 'aaa', round: 0, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb).toBeNull();
  });

  it('carries the round forward for a failing-check-only continuation (no new review)', () => {
    const fb = detectPrFeedback({
      status: status({ checks: [check({ conclusion: 'FAILURE' })] }),
      watermark: { head: 'aaa', round: 2, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb?.triggers).toEqual(['failing_check']);
    expect(fb?.round).toBe(2); // same event → counter preserved
  });

  it('triggers on a foreign commit at the tip but not on our own commit', () => {
    const foreign = detectPrFeedback({
      status: status({ commits: [commit({ sha: 'aaa', author: 'shreni-bot' }), commit({ sha: 'ccc', author: 'collaborator' })] }),
      watermark: { head: 'aaa', round: 0, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(foreign?.triggers).toEqual(['foreign_commit']);
    expect(foreign?.foreignCommits.map((c) => c.sha)).toEqual(['ccc']);

    const ours = detectPrFeedback({
      status: status({ commits: [commit({ sha: 'ddd', author: 'shreni-bot' })] }),
      watermark: { head: 'aaa', round: 0, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(ours).toBeNull();
  });

  it('does not re-trigger a foreign commit already adopted as the watermark head', () => {
    const fb = detectPrFeedback({
      status: status({ commits: [commit({ sha: 'ccc', author: 'collaborator' })] }),
      watermark: { head: 'ccc', round: 1, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb).toBeNull();
  });

  it('collects multiple concurrent triggers', () => {
    const fb = detectPrFeedback({
      status: status({
        reviews: [review({ submittedAt: '2026-07-29T14:00:00Z' })],
        checks: [check({ conclusion: 'FAILURE' })],
        commits: [commit({ sha: 'ccc', author: 'collaborator' })],
      }),
      watermark: { head: 'aaa', round: 1, at: '2026-07-29T10:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb?.triggers).toEqual(['changes_requested', 'failing_check', 'foreign_commit']);
    expect(fb?.round).toBe(0); // new review resets even with other triggers present
  });
});

describe('runPrFollowupLoop', () => {
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
    mockBuildContext.mockResolvedValue({ taskDetails: 'td', kshetra: kshetra(), task: TASK });
  });

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

it('exports the follow-up label', () => {
  expect(PR_NEEDS_FOLLOWUP_LABEL).toBe('pr-needs-followup');
});
