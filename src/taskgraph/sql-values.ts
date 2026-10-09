import { sql, type RawBuilder } from 'kysely';

// Values that go over as text and are cast in SQL, so every driver sends them
// the same way. The inner cast to text matters: postgres.js asks the server for
// parameter types, and a parameter the server infers as jsonb would be
// JSON-encoded a second time and stored as a string. Write every jsonb, array
// and timestamp parameter through these.

export const jsonb = (v: unknown): RawBuilder<unknown> => sql`cast(cast(${JSON.stringify(v)} as text) as jsonb)`;

export const textArray = (xs: readonly string[]): RawBuilder<string[]> =>
  sql`array(select jsonb_array_elements_text(${jsonb(xs)}))`;

export const timestamp = (d: Date | null): RawBuilder<Date | null> =>
  sql`cast(cast(${d ? d.toISOString() : null} as text) as timestamptz)`;
