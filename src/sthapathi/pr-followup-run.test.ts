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

const mockShow = vi.fn<() => Promise<string>>();
const mockAddNote = vi.fn<() => Promise<string>>();
const mockRemoveLabel = vi.fn<() => Promise<string>>();
const mockFlag = vi.fn<() => Promise<string>>();
const mockSyncBeads = vi.fn<() => Promise<void>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ show: mockShow, addNote: mockAddNote, removeLabel: mockRemoveLabel, flag: mockFlag })),
  syncBeads: mockSyncBeads,
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
  mockShow.mockResolvedValue(JSON.stringify({ id: TASK.id })); // no notes → zeroed watermark
  mockHeadSha.mockResolvedValue('newsha');
});

describe('runPrFollowupTask', () => {
  it('approved: pushes BEFORE replying, then advances the watermark and drops the label', async () => {
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
    // watermark advanced (head=newsha) and marker removed
    expect(mockAddNote).toHaveBeenCalledWith(TASK.id, expect.stringContaining('pr-followup-head:newsha'));
    expect(mockRemoveLabel).toHaveBeenCalledWith(TASK.id, 'pr-needs-followup');
  });

  it('a push failure posts NO reply and keeps the label for retry', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(
      loopResult({ output: { commentResponses: [{ commentId: 'c0', disposition: 'change', reply: 'done' }] } as never }),
    );
    mockPush.mockRejectedValue(new Error('non-fast-forward'));

    const res = await runPrFollowupTask(KSHETRA, TASK);

    expect(res.approved).toBe(false);
    expect(mockPrReply).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled(); // label kept → retried next pass
    expect(mockAddNote).toHaveBeenCalledWith(TASK.id, expect.stringContaining('push failed'));
  });

  it('escalated: drops the label, flags a human, and notifies — no push', async () => {
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    mockRunLoop.mockResolvedValue(loopResult({ outcome: 'escalated', note: 'needs a human' }));

    const res = await runPrFollowupTask(KSHETRA, TASK);

    expect(res.approved).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockRemoveLabel).toHaveBeenCalledWith(TASK.id, 'pr-needs-followup');
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

  it('skips and clears the label when the PR is no longer OPEN', async () => {
    mockPrStatus.mockResolvedValue({ ...openStatusWithReview(), state: 'MERGED' });
    const res = await runPrFollowupTask(KSHETRA, TASK);
    expect(res.approved).toBe(false);
    expect(mockRemoveLabel).toHaveBeenCalledWith(TASK.id, 'pr-needs-followup');
    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it('clears the label and does nothing when there is no unaddressed feedback', async () => {
    // A watermark newer than the review → detectPrFeedback returns null.
    mockShow.mockResolvedValue(
      JSON.stringify({ id: TASK.id, notes: 'pr-followup-head:h pr-followup-round:1 pr-followup-at:2026-07-29T23:00:00Z' }),
    );
    mockPrStatus.mockResolvedValue(openStatusWithReview());
    const res = await runPrFollowupTask(KSHETRA, TASK);
    expect(res.approved).toBe(false);
    expect(mockRunLoop).not.toHaveBeenCalled();
    expect(mockRemoveLabel).toHaveBeenCalledWith(TASK.id, 'pr-needs-followup');
  });
});
