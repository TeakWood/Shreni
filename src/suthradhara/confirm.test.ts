import { describe, it, expect } from 'vitest';
import {
  parseConfirmFrame,
  hasPendingProposal,
  presentProposal,
  applyConfirmFrame,
} from './confirm';
import { newSessionState } from './state';
import type { Decomposition } from './decomposition';

const NOW = '2026-07-27T10:00:00.000Z';

function fresh() {
  return newSessionState('myapp-20260727T100000-abcd', 'myapp', NOW);
}

function decomp(): Decomposition {
  return {
    epic: { ref: 'epic', title: 'CSV import', type: 'epic', priority: 2 },
    children: [
      {
        ref: 'parse',
        title: 'Parse CSV',
        type: 'task',
        priority: 1,
        acceptanceCriteria: 'rows parsed',
      },
    ],
    deps: [],
  };
}

describe('parseConfirmFrame', () => {
  it('classifies explicit confirms', () => {
    for (const t of ['confirm', 'Confirmed.', 'approve', 'file it', 'ship it', 'LGTM', 'yes']) {
      expect(parseConfirmFrame(t)).toBe('confirm');
    }
  });

  it('classifies edits and cancels', () => {
    for (const t of ['edit', 'please revise the titles', 'change child 2', 'not quite']) {
      expect(parseConfirmFrame(t)).toBe('edit');
    }
    for (const t of ['cancel', 'discard this', 'never mind', 'scrap it', 'abort']) {
      expect(parseConfirmFrame(t)).toBe('cancel');
    }
  });

  it('returns null for an ordinary interview turn', () => {
    expect(parseConfirmFrame('what about error handling?')).toBeNull();
    expect(parseConfirmFrame('the users are analysts')).toBeNull();
  });

  it('never treats a mixed/ambiguous message as a confirm (authority errs to not-write)', () => {
    // "confirm but change the title" carries both signals — it must NOT file.
    expect(parseConfirmFrame('confirm but change the title')).toBe('edit');
    expect(parseConfirmFrame('looks good, but cancel the last child')).toBe('cancel');
  });
});

describe('presentProposal', () => {
  it('holds a valid proposal in the session without filing anything', () => {
    const r = presentProposal(fresh(), decomp(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(hasPendingProposal(r.state)).toBe(true);
      expect(r.state.pending?.presentedAt).toBe(NOW);
      expect(r.state.pending?.decomposition.epic.ref).toBe('epic');
    }
  });

  it('refuses to hold a malformed proposal', () => {
    const bad = decomp();
    bad.children[0].acceptanceCriteria = '';
    const r = presentProposal(fresh(), bad, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('holds the design-doc body when one is supplied, and omits it when blank', () => {
    const withDoc = presentProposal(fresh(), decomp(), NOW, '# CSV import\n\nDesign.');
    expect(withDoc.ok).toBe(true);
    if (withDoc.ok) expect(withDoc.state.pending?.docContent).toBe('# CSV import\n\nDesign.');

    const blank = presentProposal(fresh(), decomp(), NOW, '   ');
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.state.pending?.docContent).toBeUndefined();
  });

  it('re-presenting replaces the previously held proposal', () => {
    const first = presentProposal(fresh(), decomp(), NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const changed = decomp();
    changed.epic.title = 'CSV & TSV import';
    const second = presentProposal(first.state, changed, NOW);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.state.pending?.decomposition.epic.title).toBe('CSV & TSV import');
  });
});

describe('applyConfirmFrame — server is authority', () => {
  it('files nothing until an explicit confirm: no pending → confirm is a no-op', () => {
    // The "no bd write before confirm" guarantee at its root: with no held
    // proposal there is nothing a confirm frame can file.
    const out = applyConfirmFrame(fresh(), 'confirm');
    expect(out.outcome).toBe('noop');
    expect('plan' in out).toBe(false);
  });

  it('on confirm, clears the pending proposal and returns its filing plan', () => {
    const held = presentProposal(fresh(), decomp(), NOW);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const out = applyConfirmFrame(held.state, 'confirm');
    expect(out.outcome).toBe('confirmed');
    if (out.outcome === 'confirmed') {
      // The plan files the epic + child (parent+children); no dep edges here.
      const creates = out.plan.steps.filter(s => s.kind === 'create');
      expect(creates.length).toBe(2);
      // Pending is cleared so a second confirm cannot double-file.
      expect(hasPendingProposal(out.state)).toBe(false);
      expect(applyConfirmFrame(out.state, 'confirm').outcome).toBe('noop');
    }
  });

  it('on edit, discards the held proposal and reopens (files nothing)', () => {
    const held = presentProposal(fresh(), decomp(), NOW);
    if (!held.ok) throw new Error('setup');
    const out = applyConfirmFrame(held.state, 'edit');
    expect(out.outcome).toBe('reopened');
    expect(hasPendingProposal(out.state)).toBe(false);
    expect('plan' in out).toBe(false);
  });

  it('on cancel, discards the held proposal (files nothing)', () => {
    const held = presentProposal(fresh(), decomp(), NOW);
    if (!held.ok) throw new Error('setup');
    const out = applyConfirmFrame(held.state, 'cancel');
    expect(out.outcome).toBe('discarded');
    expect(hasPendingProposal(out.state)).toBe(false);
    expect('plan' in out).toBe(false);
  });

  it('the only path that yields a filing plan is a held proposal + confirm frame', () => {
    const held = presentProposal(fresh(), decomp(), NOW);
    if (!held.ok) throw new Error('setup');
    for (const frame of ['edit', 'cancel'] as const) {
      const out = applyConfirmFrame(held.state, frame);
      expect('plan' in out).toBe(false);
    }
    const confirmed = applyConfirmFrame(held.state, 'confirm');
    expect('plan' in confirmed).toBe(true);
  });
});
