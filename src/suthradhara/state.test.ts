import { describe, it, expect } from 'vitest';
import {
  newSessionState,
  emptyRubric,
  SESSION_STATE_VERSION,
  RUBRIC_KEYS,
  STAGES,
} from './state';

describe('newSessionState', () => {
  it('starts every interview in the discovery stage', () => {
    const s = newSessionState('sid', 'myapp', '2026-07-27T10:00:00.000Z');
    expect(s.stage).toBe('discovery');
  });

  it('stamps the id, kshetra, and timestamps consistently', () => {
    const now = '2026-07-27T10:00:00.000Z';
    const s = newSessionState('sid', 'myapp', now);
    expect(s.id).toBe('sid');
    expect(s.kshetraId).toBe('myapp');
    expect(s.createdAt).toBe(now);
    expect(s.updatedAt).toBe(now);
  });

  it('carries the current schema version so loadSession can reject foreign shapes', () => {
    const s = newSessionState('sid', 'myapp');
    expect(s.version).toBe(SESSION_STATE_VERSION);
  });

  it('initialises the rubric with every key set to false', () => {
    const s = newSessionState('sid', 'myapp');
    for (const key of RUBRIC_KEYS) {
      expect(s.rubric[key]).toBe(false);
    }
  });

  it('starts with empty requirements, transcript, and open questions', () => {
    const s = newSessionState('sid', 'myapp');
    expect(s.requirements).toEqual([]);
    expect(s.transcript).toEqual([]);
    expect(s.openQuestions).toEqual([]);
  });
});

describe('emptyRubric', () => {
  it('returns a fresh object each call (no shared mutable default)', () => {
    const a = emptyRubric();
    const b = emptyRubric();
    a.intent = true;
    expect(b.intent).toBe(false);
  });
});

describe('STAGES', () => {
  it('lists the four interview phases plus the confirm gate', () => {
    expect(STAGES).toEqual(['discovery', 'clarify', 'decompose', 'design', 'confirm']);
  });
});
