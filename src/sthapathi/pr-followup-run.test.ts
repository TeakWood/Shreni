import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import type { PrStatus } from './gh.js';
import type { PrFollowupResult } from './pr-followup-loop.js';

// ── mocks (hoisted) ──────────────────────────────────────────────────────────
const mockPrStatus = vi.fn<() => Promise<PrStatus | null>>();
const mockPrReply = vi.fn<() => Promise<string | null>>();
vi.mock('./gh.js', () => ({ gh: vi.fn(() => ({ prStatus: mockPrStatus, prReply: mockPrReply })) }));

const mockPush = vi.fn<() => Promise<void>>();
const mockHeadSha = vi.fn<() => Promise<string>>();
vi.mock('./git.js', () => ({ git: vi.fn(() => ({ push: mockPush, headSha: mockHeadSha })) }));

// The task store: the watermark lives on the attempt's evidence, and resubmit
// puts the task back to waiting on its PR (the engine's "drop the label").
type Watermark = { head: string | null; round: number; at: string | null };
const mockReadWatermark = vi.fn<(id: string) => Promise<Watermark>>();
const mockWriteWatermark = vi.fn<(id: string, w: Watermark) => Promise<void>>();
const mockResubmit = vi.fn<(id: string, reason: string) => Promise<void>>();
const mockNote = vi.fn<(id: string, text: string) => Promise<void>>();
const mockFlag = vi.fn<(id: string, reason: string) => Promise<void>>();
vi.mock('./task-store.js', () => ({
  engineStore: vi.fn(() => ({
    readWatermark: mockReadWatermark, writeWatermark: mockWriteWatermark,
    resubmit: mockResubmit, note: mockNote, flag: mockFlag,
  })),
}));

const mockNotify = vi.fn<() => Promise<void>>();
vi.mock('./errors.js', () => ({ notifyOperator: mockNotify }));

const mockClearAttempts = vi.fn();
vi.mock('../kshetra/state.js', () => ({ clearBeadAttempts: mockClearAttempts }));

const mockRunLoop = vi.fn<() => Promise<PrFollowupResult>>();
vi.mock('./pr-followup-loop.js', () => ({ runPrFollowupLoop: mockRunLoop }));

const mockEmit = vi.fn();
vi.mock('../telemetry/telemetry.js', () => ({ emit: mockEmit }));

const { runPrFollowupTask } = await import('./pr-followup-run.js');

// ── fixtures ─────────────────────────────────────────────────────────────────
const KSHETRA = {
  id: 'myapp',
  repo: { path: '/repo', mainBranch: 'main', prFollowup: true, prFollowupSelfLogins: [], prFollowupRequiredChecks: [] },
} as unknown as KshetraConfig;
const TASK: Task = { id: 'proj-9', slug: 'fix-thing', title: 'Fix thing', status: 'in_progress', priority: 2, followup: true };

function openStatusWithReview(): PrStatus {
  return {
    state: 'OPEN',
    url: 'https://github.com/TeakWood/myapp/pull/9',
    reviews: [{ author: 'human', state: 'CHANGES_REQUESTED', body: 'fix it', submittedAt: '2026-07-29T12:00:00Z', comments: [] }],
    checks: [],
    commits: [],
  };
}
function loopResult(over: Partial<PrFollowupResult>): PrFollowupResult {
  return { outcome: 'approved', output: null, rounds: 1, note: '', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadWatermark.mockResolvedValue({ head: null, round: 0, at: null }); // never followed up
  mockHeadSha.mockResolvedValue('newsha');
});

describe('runPrFollowupTask', () => {
  it('approved: pushes BEFORE replying, then advances the watermark and resubmits', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(
      loopResult({ output: { commentResponses: [{ commentId: 'c0', disposition: 'change', reply: 'done' }] } as never, rounds: 1 }),
    );

    const res = await runPrFollowupTask(KSHETRA, TASK);

    expect(res.approved).toBe(true);
    expect(mockPush).toHaveBeenCalledWith('origin', 'bead-proj-9/fix-thing');
    expect(mockPrReply).toHaveBeenCalledWith('bead-proj-9/fix-thing', 'done');
    // push STRICTLY precedes reply
    expect(mockPush.mock.invocationCallOrder[0]).toBeLessThan(mockPrReply.mock.invocationCallOrder[0]);
    // watermark advanced (head=newsha), and back to waiting on the PR
    expect(mockWriteWatermark).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ head: 'newsha', round: 1 }));
    expect(mockResubmit).toHaveBeenCalledWith(TASK.id, expect.stringContaining('PR follow-up pushed'));
    expect(mockWriteWatermark.mock.invocationCallOrder[0]).toBeLessThan(mockResubmit.mock.invocationCallOrder[0]);
  });

  it('a push failure posts NO reply, leaves the watermark, and resubmits for a retry', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(
      loopResult({ output: { commentResponses: [{ commentId: 'c0', disposition: 'change', reply: 'done' }] } as never }),
    );
    mockPush.mockRejectedValue(new Error('non-fast-forward'));

    const res = await runPrFollowupTask(KSHETRA, TASK);

    expect(res.approved).toBe(false);
    expect(mockPrReply).not.toHaveBeenCalled();
    expect(mockWriteWatermark).not.toHaveBeenCalled(); // same feedback re-detected next pass
    expect(mockNote).toHaveBeenCalledWith(TASK.id, expect.stringContaining('push failed'));
    expect(mockResubmit).toHaveBeenCalledWith(TASK.id, expect.stringContaining('push failed'));
  });

  it('escalated: flags a human and notifies — no push', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(loopResult({ outcome: 'escalated', note: 'needs a human' }));

    const res = await runPrFollowupTask(KSHETRA, TASK);

    expect(res.approved).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockResubmit).not.toHaveBeenCalled();
    expect(mockFlag).toHaveBeenCalledWith(TASK.id, expect.stringContaining('escalated'));
    expect(mockNotify).toHaveBeenCalledWith(KSHETRA, TASK, 'pr_followup_escalated');
    expect(mockEmit).toHaveBeenCalledWith('pr_followup_escalated', { rounds: 1 });
  });

  it('exhausted routes to the human handoff path', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(loopResult({ outcome: 'exhausted', note: 'out of rounds', rounds: 3 }));

    const res = await runPrFollowupTask(KSHETRA, TASK);
    expect(res.approved).toBe(false);
    expect(mockNotify).toHaveBeenCalledWith(KSHETRA, TASK, 'pr_followup_exhausted');
    expect(mockEmit).toHaveBeenCalledWith('pr_followup_exhausted', { rounds: 3 });
  });

  it('an approved outcome fires NO escalated/exhausted telemetry', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(loopResult({ output: { commentResponses: [] } as never, rounds: 1 }));

    await runPrFollowupTask(KSHETRA, TASK);
    expect(mockEmit).not.toHaveBeenCalledWith('pr_followup_escalated', expect.anything());
    expect(mockEmit).not.toHaveBeenCalledWith('pr_followup_exhausted', expect.anything());
  });

  it('skips and resubmits when the PR is no longer OPEN, for reconcile to settle', async () => {
    mockPrStatus.mockResolvedValue({ ...openStatusWithReview(), state: 'MERGED' });
    const res = await runPrFollowupTask(KSHETRA, TASK);
    expect(res.approved).toBe(false);
    expect(mockResubmit).toHaveBeenCalledWith(TASK.id, expect.stringContaining('no longer open'));
    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it('resubmits and does nothing else when there is no unaddressed feedback', async () => {
    // A watermark newer than the review → detectPrFeedback returns null.
    mockReadWatermark.mockResolvedValue({ head: 'h', round: 1, at: '2026-07-29T23:00:00Z' });
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    const res = await runPrFollowupTask(KSHETRA, TASK);
    expect(res.approved).toBe(false);
    expect(mockRunLoop).not.toHaveBeenCalled();
    expect(mockResubmit).toHaveBeenCalledWith(TASK.id, 'no unaddressed feedback');
  });
});
