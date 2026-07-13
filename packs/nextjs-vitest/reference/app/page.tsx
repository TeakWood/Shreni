import { listNotes } from '@/domain/notes';

export default function HomePage() {
  const notes = listNotes();
  return (
    <main>
      <h1>Chitti Mini</h1>
      <ul>
        {notes.map(n => (
          <li key={n.id}>{n.title}</li>
        ))}
      </ul>
    </main>
  );
}
