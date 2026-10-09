import { describe, it, expect, onTestFinished } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, createMigratedTestDb, PGLITE_TIMEOUT, type TestDb } from './pglite';
import { pendingMigrations } from '../migrate';

// Closes the database even when an assertion fails, so a failing test doesn't
// leak a PGlite instance into the rest of the worker.
async function openDb(): Promise<TestDb> {
  const t = await createTestDb();
  onTestFinished(() => t.close());
  return t;
}

describe('PGlite test harness', { timeout: PGLITE_TIMEOUT }, () => {
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

describe('migrated test databases', { timeout: PGLITE_TIMEOUT }, () => {
  it('come migrated, and each is independent of the others', async () => {
    const a = await createMigratedTestDb();
    onTestFinished(() => a.close());
    const b = await createMigratedTestDb();
    onTestFinished(() => b.close());
    await a.pglite.exec(`insert into taskgraph.lifecycles (name, version, definition, hash) values ('l', 1, '{}', 'h')`);
    const r = await b.pglite.query<{ n: number }>(`select count(*)::int as n from taskgraph.lifecycles`);
    expect(r.rows[0].n).toBe(0);
    expect(await pendingMigrations(a.db)).toEqual([]);
  });
});
