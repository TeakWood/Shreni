import { describe, it, expect } from 'vitest';
import { newSessionState } from './state';
import {
  recordUserTurn,
  recordAssistantTurn,
  addRequirement,
  setSource,
} from './interview';

const NOW = '2026-07-27T10:00:00.000Z';

function fresh() {
  return newSessionState('sid-20260727T100000-abcd', 'myapp', NOW);
}

describe('recordUserTurn / recordAssistantTurn', () => {
  it('appends turns with role and timestamp, preserving order', () => {
    let s = fresh();
    s = recordUserTurn(s, 'I want a CSV importer', NOW);
    s = recordAssistantTurn(s, 'Who uses it?', '2026-07-27T10:01:00.000Z');
    expect(s.transcript).toEqual([
      { role: 'user', content: 'I want a CSV importer', at: NOW },
      { role: 'assistant', content: 'Who uses it?', at: '2026-07-27T10:01:00.000Z' },
    ]);
  });

  it('does not mutate the input state', () => {
    const s0 = fresh();
    recordUserTurn(s0, 'hi', NOW);
    expect(s0.transcript).toEqual([]);
  });
});

describe('addRequirement', () => {
  it('appends a trimmed requirement bullet', () => {
    const s = addRequirement(fresh(), '  accept CSV and TSV  ');
    expect(s.requirements).toEqual(['accept CSV and TSV']);
  });

  it('ignores empties and exact duplicates', () => {
    let s = fresh();
    s = addRequirement(s, 'accept CSV');
    s = addRequirement(s, 'accept CSV');
    s = addRequirement(s, '   ');
    expect(s.requirements).toEqual(['accept CSV']);
  });
});

describe('setSource (pmb.7)', () => {
  it('records the trimmed source ref and pull time on the first pull', () => {
    const s = setSource(fresh(), '  jira:PROJ-123  ', NOW);
    expect(s.source).toEqual({ ref: 'jira:PROJ-123', pulledAt: NOW });
  });

  it('is monotonic — the first pull wins; a later ref is a no-op', () => {
    let s = setSource(fresh(), 'jira:PROJ-123', NOW);
    s = setSource(s, 'jira:PROJ-999', '2026-07-27T11:00:00.000Z');
    expect(s.source).toEqual({ ref: 'jira:PROJ-123', pulledAt: NOW });
  });

  it('ignores an empty ref', () => {
    expect(setSource(fresh(), '   ', NOW).source).toBeUndefined();
  });

  it('does not mutate the input state', () => {
    const s0 = fresh();
    setSource(s0, 'jira:PROJ-123', NOW);
    expect(s0.source).toBeUndefined();
  });
});
