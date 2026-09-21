import { describe, it, expect } from 'vitest';
import { parseBeadDetail, classifyBeadDetail, type BeadDetail } from './drain-classify';

// `bd show <id> --json` payload: [bead, ...deps]. Helper to build one.
function showPayload(bead: Record<string, unknown>, deps: Record<string, unknown>[] = []): string {
  return JSON.stringify([{ ...bead, dependencies: deps }, ...deps]);
}

describe('parseBeadDetail', () => {
  it('extracts notes, status, and OPEN blocker ids (blocks deps, not closed)', () => {
    const json = showPayload(
      { id: 'b1', status: 'open', notes: 'some note' },
      [
        { id: 'blk-open', status: 'open', dependency_type: 'blocks' },
        { id: 'blk-closed', status: 'closed', dependency_type: 'blocks' },
        { id: 'the-epic', status: 'open', dependency_type: 'parent-child' }, // NOT a blocker
      ],
    );
    const d = parseBeadDetail(json, 'b1');
    expect(d).toEqual({ notes: 'some note', status: 'open', openBlockers: ['blk-open'] });
  });

  it('returns null for an unparseable payload or a missing bead', () => {
    expect(parseBeadDetail('not json', 'b1')).toBeNull();
    expect(parseBeadDetail(showPayload({ id: 'other', status: 'open' }), 'b1')).toBeNull();
  });

  it('defaults notes to empty and blockers to none when absent', () => {
    const d = parseBeadDetail(showPayload({ id: 'b1', status: 'open' }), 'b1');
    expect(d).toEqual({ notes: '', status: 'open', openBlockers: [] });
  });
});

const detail = (over: Partial<BeadDetail> = {}): BeadDetail =>
  ({ notes: '', status: 'open', openBlockers: [], ...over });

describe('classifyBeadDetail', () => {
  it('classifies a [needs-human] bead as needs-human', () => {
    const c = classifyBeadDetail('mid', detail({ status: 'blocked', notes: '[needs-human] Could not restore green after 3 rounds' }), { paused: false, ready: false });
    expect(c).toMatchObject({ beadId: 'mid', category: 'needs-human' });
  });

  it('classifies a bead with open blockers as blocked-by (naming them)', () => {
    const c = classifyBeadDetail('dep', detail({ openBlockers: ['mid', 'other'] }), { paused: false, ready: false });
    expect(c).toMatchObject({ category: 'blocked-by' });
    expect(c.reason).toContain('mid');
    expect(c.reason).toContain('other');
  });

  it('budget beats everything and flips to the budget category', () => {
    const c = classifyBeadDetail('b1', detail({ status: 'blocked', notes: 'Agent failed: bead b1 has spent $5 of its $5 per-bead budget cap', openBlockers: ['x'] }), { paused: true, ready: true });
    expect(c.category).toBe('budget');
    expect(c.reason).toContain('budget cap');
  });

  it('needs-human is named on the ROOT bead even though its dependents are blocked-by it', () => {
    // The flagged bead itself: blocked status, needs-human note, no open blockers.
    const root = classifyBeadDetail('mid', detail({ status: 'blocked', notes: '[needs-human] ...' }), { paused: false, ready: false });
    expect(root.category).toBe('needs-human');
    // Its dependent: open, blocked by the root.
    const dep = classifyBeadDetail('dep', detail({ status: 'open', openBlockers: ['mid'] }), { paused: false, ready: false });
    expect(dep.category).toBe('blocked-by');
    expect(dep.reason).toContain('mid');
  });

  it('classifies an exhausted (round-cap) bead', () => {
    const c = classifyBeadDetail('e', detail({ status: 'blocked', notes: 'Blocked after 3 rounds — reviewer kept rejecting.' }), { paused: false, ready: false });
    expect(c.category).toBe('exhausted');
  });

  it('classifies a generic flagged bead as blocked', () => {
    const c = classifyBeadDetail('g', detail({ status: 'blocked', notes: 'Git failure: push rejected. Branch kept.' }), { paused: false, ready: false });
    expect(c.category).toBe('blocked');
  });

  it('classifies an unflagged unworked bead under a paused kshetra as paused', () => {
    const c = classifyBeadDetail('p', detail({ status: 'open' }), { paused: true, ready: true });
    expect(c.category).toBe('paused'); // paused wins over ready-but-unworked
  });

  it('flags a ready-but-unworked bead loudly (should not happen)', () => {
    const c = classifyBeadDetail('r', detail({ status: 'open' }), { paused: false, ready: true });
    expect(c.category).toBe('ready-but-unworked');
    expect(c.reason.toLowerCase()).toContain('should not happen');
  });

  it('falls back to open for an unflagged, unblocked, non-ready bead', () => {
    const c = classifyBeadDetail('o', detail({ status: 'deferred' }), { paused: false, ready: false });
    expect(c.category).toBe('open');
  });
});
