import { describe, it, expect } from 'vitest';
import { newSessionState } from './state';
import { checkRubricItem, deferRubricItem } from './rubric';
import { addRequirement } from './interview';
import { buildSystemPrompt } from './prompt';
import type { KshetraConfig } from '../kshetra/config';

const NOW = '2026-07-27T10:00:00.000Z';

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/repos/myapp' },
  agents: { model: 'claude-opus-4-8' },
} as unknown as KshetraConfig;

function fresh() {
  return newSessionState('sid-20260727T100000-abcd', 'myapp', NOW);
}

describe('buildSystemPrompt', () => {
  it('states the boundary: model proposes, server files only on confirm', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).toMatch(/Read\/Grep\/Glob/);
    expect(p).toMatch(/do NOT file beads yourself/i);
    expect(p).toMatch(/explicit confirm/i);
    expect(p).toMatch(/nothing is written|until that confirm, nothing/i);
  });

  it('names the active Kshetra and its repo path', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).toContain('myapp');
    expect(p).toContain('/repos/myapp');
  });

  it('marks the current stage as YOU ARE HERE and steers to its purpose', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).toMatch(/CURRENT STAGE: discovery/);
    expect(p).toMatch(/discovery.*YOU ARE HERE/);

    const clarify = buildSystemPrompt({ ...fresh(), stage: 'clarify' }, KSHETRA);
    expect(clarify).toMatch(/CURRENT STAGE: clarify/);
    expect(clarify).toMatch(/clarify.*YOU ARE HERE/);
  });

  it('injects the live rubric state so the model sees what is checked', () => {
    let s = fresh();
    s = checkRubricItem(s, 'intent');
    s = deferRubricItem(s, 'nonFunctional', 'perf budget?', NOW);
    const p = buildSystemPrompt(s, KSHETRA);
    expect(p).toMatch(/\[x] Intent/);
    expect(p).toMatch(/\[~] Non-functional .*deferred \(Q1\)/);
    expect(p).toMatch(/\[ ] Scope boundary/);
  });

  it('carries the design rules: no early jump, show rubric on ask, defer ≠ blocker', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).toMatch(/Do NOT jump to a decomposition proposal/);
    expect(p).toMatch(/are we ready\?/);
    expect(p).toMatch(/deferred \(Qn\)/);
  });

  it('describes the decomposition proposal shape (design note + epic + children + deps)', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).toMatch(/DECOMPOSITION PROPOSAL/);
    expect(p).toMatch(/Design note/);
    expect(p).toMatch(/acceptance criteria/i);
    expect(p).toMatch(/Dependency edges/);
    expect(p).toMatch(/Confirm \/ Edit \/ Cancel/);
  });

  it('lists captured requirements when present', () => {
    const s = addRequirement(fresh(), 'accept CSV and TSV');
    const p = buildSystemPrompt(s, KSHETRA);
    expect(p).toMatch(/Requirements captured so far:/);
    expect(p).toMatch(/- accept CSV and TSV/);
  });
});
