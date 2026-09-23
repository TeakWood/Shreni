import { describe, it, expect } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import { buildPlanningPrompt, DESIGN_DIR } from './prompt';
import { handoffRelPath } from './handoff';

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:me/myapp.git', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads/.beads', remote: 'git@github.com:me/myapp-beads.git' },
  agents: { model: 'claude-opus-4-8' },
} as unknown as KshetraConfig;

describe('buildPlanningPrompt', () => {
  const prompt = buildPlanningPrompt(KSHETRA);

  it('names the Kshetra and repo it is planning against', () => {
    expect(prompt).toContain('Active Kshetra: myapp');
    expect(prompt).toContain('/projects/myapp');
  });

  it('walks the five interview stages', () => {
    for (const stage of ['discovery', 'clarify', 'decompose', 'design', 'confirm']) {
      expect(prompt).toContain(stage);
    }
  });

  it('carries both completion gates', () => {
    expect(prompt).toContain('GATE ①');
    expect(prompt).toContain('GATE ②');
  });

  it('grounds the beads-sync and doc-push in the real remotes/paths', () => {
    expect(prompt).toContain(KSHETRA.beads.remote);
    expect(prompt).toContain('bd export -o "$BEADS_DIR/issues.jsonl"');
    expect(prompt).toContain(`${DESIGN_DIR}/<YYYY-MM-DD>-<slug>.md`);
    expect(prompt).toContain('git switch -c suthradhara/<slug>');
    expect(prompt).toContain(`NEVER merge to ${KSHETRA.repo.mainBranch}`);
  });

  it('instructs a dated ADR with frontmatter, not an undated evolve-in-place doc (l4y.2)', () => {
    // The write path is the dated ADR convention, never the old undated filename.
    expect(prompt).toContain(`${DESIGN_DIR}/<YYYY-MM-DD>-<slug>.md`);
    expect(prompt).not.toContain(`${DESIGN_DIR}/<slug>.md`);
    // ADR frontmatter shape.
    expect(prompt).toContain('status: accepted');
    expect(prompt).toContain('superseded-by');
    // Design docs are the dated, immutable ADR convention; a change supersedes.
    expect(prompt).toContain('dated, immutable ADRs');
    expect(prompt).toContain('status: superseded');
    expect(prompt).not.toContain('EVOLVE it in place');
  });

  it('handoff docPath uses the dated ADR filename', () => {
    expect(prompt).toContain(`"docPath": "${DESIGN_DIR}/<YYYY-MM-DD>-<slug>.md"`);
  });

  it('instructs writing the handoff at the known path', () => {
    expect(prompt).toContain(handoffRelPath());
  });

  it('drops the old server-side delta protocol', () => {
    expect(prompt).not.toContain('state delta');
    expect(prompt).not.toContain('advanceStage');
    expect(prompt).not.toContain('SUTHRADHARA_DELTA');
  });

  it('adds the extend block only when a prior doc is seeded', () => {
    expect(prompt).not.toContain('EXTENDING AN EXISTING PLAN');
    const extended = buildPlanningPrompt(KSHETRA, { extendDocRelPath: '.shreni/design/2026-09-16-sso.md' });
    expect(extended).toContain('EXTENDING AN EXISTING PLAN');
    expect(extended).toContain('.shreni/design/2026-09-16-sso.md');
    // Extending a decision writes a new superseding ADR, not an in-place rewrite.
    expect(extended).toContain('NEW dated ADR that supersedes');
    expect(extended).toContain('do not rewrite the prior ADR');
  });

  describe('sizing rubric + coverage check (a32)', () => {
    // The decompose stage points at the rubric, and the rubric lives inside the
    // proposal shape — one structure, not a parallel system.
    const proposalAt = prompt.indexOf('DECOMPOSITION PROPOSAL');
    const rubricAt = prompt.indexOf('SIZING RUBRIC —');
    const protocolAt = prompt.indexOf('COMPLETION PROTOCOL');

    it('carries the rubric inside the proposal shape, before the approval ask and the protocol', () => {
      expect(proposalAt).toBeGreaterThan(-1);
      expect(rubricAt).toBeGreaterThan(proposalAt);
      expect(prompt.indexOf('Approve / Edit / Cancel')).toBeGreaterThan(rubricAt);
      expect(protocolAt).toBeGreaterThan(rubricAt);
      expect(prompt).toContain('the unit of a bead is the REVIEW, not the directory');
      expect(prompt).toContain('sized by the SIZING RUBRIC for one reviewable Silpi ↔ Viharapala pass');
    });

    it('keeps every rule of the rubric', () => {
      for (const rule of [
        'One decision per bead',
        'Difficulty, not directory, sets the boundary',
        'Name the hard files',
        'pathological are ALWAYS their own beads',
        'Chokepoints first',
        'states its dependent count',
        'No batching prose inside a bead',
        'ONLY as dependency edges',
        'Smell tests',
        'Independently mergeable',
        'Prefer more, smaller beads',
      ]) {
        expect(prompt).toContain(rule);
      }
    });

    it('requires an explicit coverage result, exclusions, child count, and shape rationale', () => {
      expect(prompt).toContain('Coverage check');
      const flat = prompt.replace(/\s+/g, ' ');
      expect(flat).toContain('each change it needs owned by exactly one child (no gaps, no overlaps');
      expect(flat).toContain('deliberately does NOT touch, and why');
      expect(prompt).toContain('State the child count');
      expect(prompt).toContain('the coverage check passes');
    });

    it('grounds the smell test and round budget in the Kshetra config, defaulting when absent', () => {
      // The fixture carries no gates/maxRoundsPerBead — the schema defaults apply.
      const flat = (p: string) => p.replace(/\s+/g, ' ');
      expect(flat(prompt)).toContain('more than ~20 files');
      expect(flat(prompt)).toContain('(more than 40 files or 1500 changed lines');
      expect(prompt).toContain('only 3 review rounds');
      const tuned = buildPlanningPrompt({
        ...KSHETRA,
        gates: { diffSize: { level: 'block', maxFiles: 12, maxLines: 400 } },
        agents: { ...KSHETRA.agents, maxRoundsPerBead: 5 },
      } as unknown as KshetraConfig);
      // The file smell never exceeds the real gate.
      expect(flat(tuned)).toContain('more than ~12 files');
      expect(flat(tuned)).toContain('(more than 12 files or 400 changed lines');
      expect(tuned).toContain('only 5 review rounds');
      // A partial, unparsed diffSize still renders numbers, never `undefined`.
      const partial = buildPlanningPrompt({
        ...KSHETRA,
        gates: { diffSize: { maxFiles: 12 } },
      } as unknown as KshetraConfig);
      expect(flat(partial)).toContain('(more than 12 files or 1500 changed lines');
      expect(partial).not.toContain('undefined');
    });

    it('stays within its size envelope', () => {
      // Pre-a32 the prompt was ~7.6k chars, ~10k with the rubric (short-path
      // fixture, so this bounds the template, not a real Kshetra's interpolated
      // paths). The rubric must stay short enough to survive alongside the
      // completion protocol — growing past this is a deliberate decision.
      expect(prompt.length).toBeLessThan(11_000);
    });
  });
});
