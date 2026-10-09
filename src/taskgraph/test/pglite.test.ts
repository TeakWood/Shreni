import { describe, it, expect, onTestFinished } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, type TestDb } from './pglite';

// Closes the database even when an assertion fails, so a failing test doesn't
// leak a PGlite instance into the rest of the worker.
async function openDb(): Promise<TestDb> {
  const t = await createTestDb();
  onTestFinished(() => t.close());
  return t;
}

describe('PGlite test harness', () => {
  it('runs SQL through Kysely and closes cleanly', async () => {
    const t = await openDb();
    await sql`create table t (id int primary key, name text not null)`.execute(t.db);
    await t.db.insertInto('t').values({ id: 1, name: 'a' }).execute();
    expect(await t.db.selectFrom('t').selectAll().execute()).toEqual([{ id: 1, name: 'a' }]);
    await t.close();
    expect(t.pglite.closed).toBe(true);
  });

  it('gives each call its own database', async () => {
    const a = await openDb();
    const b = await openDb();
    await sql`create table only_in_a (id int)`.execute(a.db);
    const r = await b.pglite.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_name = 'only_in_a'`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});
