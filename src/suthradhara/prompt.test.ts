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
    expect(prompt).toContain(`${DESIGN_DIR}/<slug>.md`);
    expect(prompt).toContain('git switch -c suthradhara/<slug>');
    expect(prompt).toContain(`NEVER merge to ${KSHETRA.repo.mainBranch}`);
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
    const extended = buildPlanningPrompt(KSHETRA, { extendDocRelPath: '.shreni/design/sso.md' });
    expect(extended).toContain('EXTENDING AN EXISTING PLAN');
    expect(extended).toContain('.shreni/design/sso.md');
  });
});
