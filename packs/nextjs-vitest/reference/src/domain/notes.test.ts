import { describe, it, expect } from 'vitest';
import { listNotes, addNote } from './notes';

describe('notes domain', () => {
  it('lists the seed note', () => {
    expect(listNotes().length).toBeGreaterThanOrEqual(1);
    expect(listNotes()[0].title).toContain('Chitti');
  });

  it('adds a note with a valid title', () => {
    const before = listNotes().length;
    const note = addNote('Buy milk');
    expect(note.title).toBe('Buy milk');
    expect(listNotes().length).toBe(before + 1);
  });

  it('rejects an empty title', () => {
    expect(() => addNote('')).toThrow();
  });
});
