import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { PrStatus, PrReview, PrCheck, PrCommit } from './gh.js';

// bd is mocked so readWatermark / selectFollowup can be driven from fixtures.
const mockShow = vi.fn<() => Promise<string>>();
const mockAddNote = vi.fn<() => Promise<string>>();
const mockList = vi.fn<() => Promise<string>>();
vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ show: mockShow, addNote: mockAddNote, list: mockList })),
}));

const {
  resolvePrFollowup,
  parseWatermark,
  formatWatermark,
  readWatermark,
  writeWatermark,
  detectPrFeedback,
  selectFollowup,
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
  mockList.mockReset();
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

  // A CHANGES_REQUESTED review with no submittedAt (partial gh data) must not
  // re-trigger forever: it counts as unaddressed only when the PR head has moved
  // since we last addressed.
  it('does NOT re-trigger a timeless review when the head has not moved since the watermark', () => {
    const fb = detectPrFeedback({
      status: status({ reviews: [review({ submittedAt: null })], commits: [commit({ sha: 'aaa', author: 'shreni-bot' })] }),
      watermark: { head: 'aaa', round: 1, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(fb).toBeNull();
  });

  it('triggers a timeless review when the head has moved (or was never addressed)', () => {
    const moved = detectPrFeedback({
      status: status({ reviews: [review({ submittedAt: null })], commits: [commit({ sha: 'aaa', author: 'shreni-bot' })] }),
      watermark: { head: 'bbb', round: 1, at: '2026-07-29T13:00:00Z' },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(moved?.triggers).toEqual(['changes_requested']);

    const firstEver = detectPrFeedback({
      status: status({ reviews: [review({ submittedAt: null })] }),
      watermark: { head: null, round: 0, at: null },
      selfLogins: SELF,
      requiredChecks: REQUIRED,
    });
    expect(firstEver?.triggers).toEqual(['changes_requested']);
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

describe('selectFollowup', () => {
  const K = { repo: { prFollowup: true } } as unknown as KshetraConfig;

  it('returns null when follow-up is disabled', async () => {
    expect(await selectFollowup({ repo: { prFollowup: false } } as unknown as KshetraConfig)).toBeNull();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('queries in_progress + pr-needs-followup and returns the first bead marked followup', async () => {
    mockList.mockResolvedValue(
      JSON.stringify([
        { id: 'proj-1', title: 'First PR', priority: 2 },
        { id: 'proj-2', title: 'Second PR', priority: 1 },
      ]),
    );
    const t = await selectFollowup(K);
    expect(mockList).toHaveBeenCalledWith({ status: 'in_progress', label: 'pr-needs-followup' });
    expect(t).toMatchObject({ id: 'proj-1', slug: 'first-pr', followup: true, status: 'in_progress' });
  });

  it('returns null when no bead carries the label', async () => {
    mockList.mockResolvedValue('[]');
    expect(await selectFollowup(K)).toBeNull();
  });

  it('degrades to null when bd list throws', async () => {
    mockList.mockRejectedValue(new Error('bd down'));
    expect(await selectFollowup(K)).toBeNull();
  });
});

it('exports the follow-up label', () => {
  expect(PR_NEEDS_FOLLOWUP_LABEL).toBe('pr-needs-followup');
});
