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

  it('omits the evolve block for a plain new-feature interview', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).not.toMatch(/EVOLVING AN EXISTING FEATURE/);
  });

  it('renders the evolve-in-place block with the loaded doc when a target is set', () => {
    const s = { ...fresh(), evolving: { feature: 'SSO', targetRelPath: '.shreni/design/sso.md', targetContent: 'EXISTING_DESIGN_BODY', locatedAt: NOW } };
    const p = buildSystemPrompt(s, KSHETRA);
    expect(p).toMatch(/EVOLVING AN EXISTING FEATURE — UPDATE IN PLACE/);
    expect(p).toContain('.shreni/design/sso.md');
    expect(p).toContain('EXISTING_DESIGN_BODY');
    expect(p).toMatch(/rewrite the SAME/i);
  });

  it('renders the pending doc-choice block when >1 doc matched', () => {
    const s = { ...fresh(), evolving: { feature: 'auth', candidates: ['.shreni/design/a.md', '.shreni/design/b.md'], locatedAt: NOW } };
    const p = buildSystemPrompt(s, KSHETRA);
    expect(p).toMatch(/DOC CHOICE PENDING/);
    expect(p).toContain('.shreni/design/a.md');
    expect(p).toContain('.shreni/design/b.md');
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

  it('instructs the model to close every turn with a suthradhara-delta block (Q10)', () => {
    const p = buildSystemPrompt(fresh(), KSHETRA);
    expect(p).toMatch(/suthradhara-delta/);
    expect(p).toMatch(/MONOTONIC LEDGER/);
    expect(p).toMatch(/checkRubric/);
    expect(p).toMatch(/advanceStage/);
    // the rubric key vocabulary the distiller validates against
    for (const key of ['intent', 'usersStories', 'successCriteria', 'scopeBoundary', 'nonFunctional', 'dependenciesUnknowns']) {
      expect(p).toContain(key);
    }
  });
});
