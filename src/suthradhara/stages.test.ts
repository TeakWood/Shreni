import { describe, it, expect } from 'vitest';
import { newSessionState } from './state';
import { checkRubricItem, deferRubricItem, RUBRIC_LABELS } from './rubric';
import {
  STAGE_META,
  nextStage,
  isGatedStage,
  tryEnterStage,
  tryAdvanceStage,
} from './stages';

const NOW = '2026-07-27T10:00:00.000Z';

function fresh() {
  return newSessionState('sid-20260727T100000-abcd', 'myapp', NOW);
}

function ready() {
  let s = fresh();
  for (const key of Object.keys(RUBRIC_LABELS) as (keyof typeof RUBRIC_LABELS)[]) {
    s = checkRubricItem(s, key);
  }
  return s;
}

describe('STAGE_META', () => {
  it('covers every stage with a hat, purpose, and exit', () => {
    for (const meta of Object.values(STAGE_META)) {
      expect(meta.hat).toBeTruthy();
      expect(meta.purpose).toBeTruthy();
      expect(meta.exit).toBeTruthy();
    }
  });
});

describe('nextStage', () => {
  it('walks the pipeline and stops at confirm', () => {
    expect(nextStage('discovery')).toBe('clarify');
    expect(nextStage('clarify')).toBe('decompose');
    expect(nextStage('design')).toBe('confirm');
    expect(nextStage('confirm')).toBeNull();
  });
});

describe('isGatedStage', () => {
  it('gates decompose and everything past it, but not discovery/clarify', () => {
    expect(isGatedStage('discovery')).toBe(false);
    expect(isGatedStage('clarify')).toBe(false);
    expect(isGatedStage('decompose')).toBe(true);
    expect(isGatedStage('design')).toBe(true);
    expect(isGatedStage('confirm')).toBe(true);
  });
});

describe('tryEnterStage — the decomposition gate', () => {
  it('refuses to enter decompose while rubric items are unchecked', () => {
    const result = tryEnterStage(fresh(), 'decompose');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/readiness rubric is not satisfied/);
      expect(result.missing.length).toBe(6);
    }
  });

  it('allows entering decompose once the rubric is satisfied', () => {
    const result = tryEnterStage(ready(), 'decompose');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.stage).toBe('decompose');
  });

  it('counts a deferred item toward the gate', () => {
    let s = fresh();
    const keys = Object.keys(RUBRIC_LABELS) as (keyof typeof RUBRIC_LABELS)[];
    for (const key of keys.slice(0, 5)) s = checkRubricItem(s, key);
    s = deferRubricItem(s, keys[5], 'deferred unknown', NOW);
    expect(tryEnterStage(s, 'decompose').ok).toBe(true);
  });

  it('never gates a move back to discovery or clarify', () => {
    const s = { ...fresh(), stage: 'clarify' as const };
    expect(tryEnterStage(s, 'discovery').ok).toBe(true);
    expect(tryEnterStage(s, 'clarify').ok).toBe(true);
  });
});

describe('tryAdvanceStage', () => {
  it('advances discovery → clarify freely', () => {
    const result = tryAdvanceStage(fresh());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.stage).toBe('clarify');
  });

  it('refuses clarify → decompose until ready', () => {
    const atClarify = { ...fresh(), stage: 'clarify' as const };
    expect(tryAdvanceStage(atClarify).ok).toBe(false);
    const atClarifyReady = { ...ready(), stage: 'clarify' as const };
    const result = tryAdvanceStage(atClarifyReady);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.stage).toBe('decompose');
  });

  it('reports there is nothing past confirm', () => {
    const atConfirm = { ...ready(), stage: 'confirm' as const };
    const result = tryAdvanceStage(atConfirm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/final stage/);
  });
});
