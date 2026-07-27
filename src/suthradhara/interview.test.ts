import { describe, it, expect } from 'vitest';
import { newSessionState } from './state';
import {
  recordUserTurn,
  recordAssistantTurn,
  addRequirement,
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
