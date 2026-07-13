import { z } from 'zod';

export const NoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
});

export type Note = z.infer<typeof NoteSchema>;

const notes: Note[] = [{ id: '1', title: 'Welcome to Chitti Mini' }];

export function listNotes(): Note[] {
  return [...notes];
}

export function addNote(title: string): Note {
  const parsed = NoteSchema.pick({ title: true }).parse({ title });
  const note: Note = { id: String(notes.length + 1), title: parsed.title };
  notes.push(note);
  return note;
}
