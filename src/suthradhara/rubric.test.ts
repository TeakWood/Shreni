import { describe, it, expect } from 'vitest';
import { newSessionState } from './state';
import {
  rubricStatus,
  isReadyToDecompose,
  checkRubricItem,
  deferRubricItem,
  addOpenQuestion,
  nextQuestionId,
  renderRubric,
  isReadinessQuery,
  RUBRIC_LABELS,
} from './rubric';

const NOW = '2026-07-27T10:00:00.000Z';

function fresh() {
  return newSessionState('sid-20260727T100000-abcd', 'myapp', NOW);
}

// Satisfy the whole rubric via genuine checks, one call at a time.
function fullyChecked() {
  let s = fresh();
  for (const key of Object.keys(RUBRIC_LABELS) as (keyof typeof RUBRIC_LABELS)[]) {
    s = checkRubricItem(s, key);
  }
  return s;
}

describe('rubricStatus', () => {
  it('reports every item missing on a fresh session', () => {
    const status = rubricStatus(fresh());
    expect(status.satisfied).toEqual([]);
    expect(status.missing).toHaveLength(6);
    expect(status.deferred).toEqual([]);
    expect(status.ready).toBe(false);
  });

  it('is ready once every item is checked', () => {
    const status = rubricStatus(fullyChecked());
    expect(status.missing).toEqual([]);
    expect(status.ready).toBe(true);
  });
});

describe('the ready gate', () => {
  it('refuses while any single item is unchecked', () => {
    let s = fresh();
    s = checkRubricItem(s, 'intent');
    s = checkRubricItem(s, 'usersStories');
    s = checkRubricItem(s, 'successCriteria');
    s = checkRubricItem(s, 'scopeBoundary');
    s = checkRubricItem(s, 'nonFunctional');
    // dependenciesUnknowns still missing
    expect(isReadyToDecompose(s)).toBe(false);
    expect(rubricStatus(s).missing).toEqual(['dependenciesUnknowns']);
  });
});

describe('deferRubricItem', () => {
  it('satisfies the item for the gate but records it as an open question, not a blocker', () => {
    let s = fullyChecked();
    // Undo one via a fresh build, then defer it instead.
    s = fresh();
    s = checkRubricItem(s, 'intent');
    s = checkRubricItem(s, 'usersStories');
    s = checkRubricItem(s, 'successCriteria');
    s = checkRubricItem(s, 'scopeBoundary');
    s = checkRubricItem(s, 'dependenciesUnknowns');
    // nonFunctional deferred rather than answered:
    s = deferRubricItem(s, 'nonFunctional', 'Do we need sub-100ms parsing?', NOW);

    expect(isReadyToDecompose(s)).toBe(true); // deferral unblocks the gate
    expect(s.openQuestions).toHaveLength(1);
    expect(s.openQuestions[0]).toMatchObject({
      id: 'Q1',
      question: 'Do we need sub-100ms parsing?',
      rubricKey: 'nonFunctional',
    });
    const status = rubricStatus(s);
    expect(status.deferred).toEqual(['nonFunctional']);
    expect(status.satisfied).toContain('nonFunctional');
  });

  it('numbers questions Q1, Q2, … so they can be referenced as deferred (Qn)', () => {
    let s = fresh();
    expect(nextQuestionId(s)).toBe('Q1');
    s = deferRubricItem(s, 'nonFunctional', 'q one', NOW);
    expect(nextQuestionId(s)).toBe('Q2');
    s = addOpenQuestion(s, 'q two', NOW);
    expect(s.openQuestions.map(q => q.id)).toEqual(['Q1', 'Q2']);
  });

  it('is immutable — the input state is untouched', () => {
    const s0 = fresh();
    const s1 = deferRubricItem(s0, 'intent', 'q', NOW);
    expect(s0.rubric.intent).toBe(false);
    expect(s0.openQuestions).toEqual([]);
    expect(s1.rubric.intent).toBe(true);
  });
});

describe('renderRubric', () => {
  it('marks checked [x], deferred [~] with its question id, and missing [ ]', () => {
    let s = fresh();
    s = checkRubricItem(s, 'intent');
    s = deferRubricItem(s, 'nonFunctional', 'perf budget?', NOW);
    const out = renderRubric(s);
    expect(out).toMatch(/NOT ready/);
    expect(out).toMatch(/\[x] Intent/);
    expect(out).toMatch(/\[~] Non-functional .*deferred \(Q1\)/);
    expect(out).toMatch(/\[ ] Scope boundary/);
  });

  it('announces readiness once satisfied', () => {
    expect(renderRubric(fullyChecked())).toMatch(/ready to propose a decomposition/);
  });
});

describe('isReadinessQuery', () => {
  it('matches the operator asking whether the interview is ready', () => {
    expect(isReadinessQuery('are we ready?')).toBe(true);
    expect(isReadinessQuery('Ready?')).toBe(true);
    expect(isReadinessQuery('can you show the rubric')).toBe(true);
    expect(isReadinessQuery('ready to decompose yet?')).toBe(true);
  });

  it('does not fire on ordinary conversation', () => {
    expect(isReadinessQuery('the importer should read CSV files')).toBe(false);
    expect(isReadinessQuery('users already have accounts')).toBe(false);
  });
});
