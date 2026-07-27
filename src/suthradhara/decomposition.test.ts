import { describe, it, expect } from 'vitest';
import { validateDecomposition, type Decomposition } from './decomposition';

// A well-formed baseline every negative test starts from and then breaks.
function valid(): Decomposition {
  return {
    epic: { ref: 'epic', title: 'CSV import', type: 'epic', priority: 2 },
    children: [
      {
        ref: 'parse',
        title: 'Parse CSV/TSV',
        type: 'task',
        priority: 1,
        acceptanceCriteria: 'Given a CSV or TSV file, rows are parsed into records.',
      },
      {
        ref: 'ui',
        title: 'Upload UI',
        type: 'feature',
        priority: 2,
        acceptanceCriteria: 'Operator can select a file and see a preview.',
      },
    ],
    deps: [{ blocked: 'ui', blocker: 'parse' }],
  };
}

describe('validateDecomposition', () => {
  it('accepts a well-formed decomposition', () => {
    expect(validateDecomposition(valid())).toEqual({ ok: true });
  });

  it('requires at least one child', () => {
    const d = valid();
    d.children = [];
    d.deps = [];
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/at least one child/);
  });

  it('requires each child to carry acceptance criteria', () => {
    const d = valid();
    d.children[0].acceptanceCriteria = '   ';
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/acceptance criteria/i);
  });

  it('rejects an out-of-range priority', () => {
    const d = valid();
    d.children[0].priority = 7;
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/out of range/);
  });

  it('rejects a non-integer priority', () => {
    const d = valid();
    d.epic.priority = 1.5;
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
  });

  it('rejects an epic typed as a non-parent type', () => {
    const d = valid();
    // task is a valid child type but not a valid parent type.
    (d.epic.type as string) = 'task';
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/Epic type/);
  });

  it('rejects a child typed as epic', () => {
    const d = valid();
    (d.children[0].type as string) = 'epic';
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate refs across epic and children', () => {
    const d = valid();
    d.children[1].ref = 'parse';
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/unique/);
  });

  it('rejects a dependency referencing an unknown child ref', () => {
    const d = valid();
    d.deps = [{ blocked: 'ui', blocker: 'nope' }];
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/unknown child ref "nope"/);
  });

  it('rejects a self-dependency', () => {
    const d = valid();
    d.deps = [{ blocked: 'ui', blocker: 'ui' }];
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/self-dependency/);
  });

  it('rejects a dependency cycle', () => {
    const d = valid();
    d.deps = [
      { blocked: 'ui', blocker: 'parse' },
      { blocked: 'parse', blocker: 'ui' },
    ];
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/cycle/);
  });

  it('collects all errors in one pass, not just the first', () => {
    const d = valid();
    d.epic.title = '';
    d.children[0].priority = 9;
    d.children[1].acceptanceCriteria = '';
    const r = validateDecomposition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});
