import { describe, it, expect } from 'vitest';
import { parseAcceptanceCriteria } from './task-json';

describe('parseAcceptanceCriteria', () => {
  const payload = JSON.stringify([
    { id: 'proj-42', acceptance_criteria: '  Login rejects a bad password.  ', description: 'desc' },
    { id: 'proj-40', acceptance_criteria: 'Parent criteria — not this task.' },
  ]);

  it('returns the trimmed acceptance_criteria of the requested task', () => {
    expect(parseAcceptanceCriteria(payload, 'proj-42')).toBe('Login rejects a bad password.');
  });

  it('selects by id, not array position', () => {
    expect(parseAcceptanceCriteria(payload, 'proj-40')).toBe('Parent criteria — not this task.');
  });

  it('returns "" when the id is absent', () => {
    expect(parseAcceptanceCriteria(payload, 'proj-99')).toBe('');
  });

  it('returns "" when the task has no acceptance_criteria', () => {
    expect(parseAcceptanceCriteria(JSON.stringify([{ id: 'proj-42' }]), 'proj-42')).toBe('');
  });

  it('returns "" on unparseable or non-array payloads', () => {
    expect(parseAcceptanceCriteria('not json', 'proj-42')).toBe('');
    expect(parseAcceptanceCriteria('   ', 'proj-42')).toBe('');
    expect(parseAcceptanceCriteria('{"id":"proj-42"}', 'proj-42')).toBe('');
  });
});
