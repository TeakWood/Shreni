import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listNotes, addNote } from '@/domain/notes';

const CreateNoteSchema = z.object({ title: z.string().min(1).max(120) });

export function GET() {
  return NextResponse.json(listNotes());
}

export async function POST(req: Request) {
  const body = CreateNoteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues }, { status: 400 });
  }
  return NextResponse.json(addNote(body.data.title), { status: 201 });
}
