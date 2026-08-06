import { describe, it, expect } from 'vitest';
import { newSessionState, SESSION_STATE_VERSION } from './state';

describe('newSessionState', () => {
  it('creates a slim active record at the current schema version', () => {
    const s = newSessionState('myapp-20260727T140312-a3f2', 'myapp', '2026-08-06T00:00:00.000Z');
    expect(s).toEqual({
      version: SESSION_STATE_VERSION,
      id: 'myapp-20260727T140312-a3f2',
      kshetraId: 'myapp',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      status: 'active',
    });
  });

  it('carries no interview-ledger fields (transcript/rubric/stage/pending are gone)', () => {
    const s = newSessionState('myapp-20260727T140312-a3f2', 'myapp') as Record<string, unknown>;
    for (const gone of ['transcript', 'rubric', 'stage', 'pending', 'requirements', 'openQuestions']) {
      expect(s[gone]).toBeUndefined();
    }
  });

  it('is at schema version 2 (the launched-session record)', () => {
    expect(SESSION_STATE_VERSION).toBe(2);
  });
});
