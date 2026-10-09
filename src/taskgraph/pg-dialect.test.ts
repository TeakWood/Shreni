import { describe, it, expect, onTestFinished } from 'vitest';
import { Kysely, sql } from 'kysely';
import { createWireTestDb, PGLITE_TIMEOUT } from './test/pglite';
import { PostgresJsDialect } from './pg-dialect';
import { migrate, pendingMigrations } from './migrate';
import { runTransaction } from './tx';

async function open() {
  const w = await createWireTestDb();
  const db = new Kysely<any>({ dialect: new PostgresJsDialect({ sql: w.sql }) });
  onTestFinished(async () => { await db.destroy(); await w.close(); });
  return { ...w, db };
}

describe('PostgresJsDialect', { timeout: PGLITE_TIMEOUT }, () => {
  it('runs queries, returning rows and affected counts', async () => {
    const t = await open();
    await sql`create table t (id int primary key, name text)`.execute(t.db);
    const ins = await t.db.insertInto('t').values([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).executeTakeFirst();
    expect(ins.numInsertedOrUpdatedRows).toBe(2n);
    const upd = await t.db.updateTable('t').set({ name: 'z' }).where('id', '=', 1).executeTakeFirst();
    expect(upd.numUpdatedRows).toBe(1n);
    expect(await t.db.selectFrom('t').selectAll().orderBy('id').execute()).toEqual([{ id: 1, name: 'z' }, { id: 2, name: 'b' }]);
  });

  it('migrates and runs engine transactions, which commit and roll back', async () => {
    const t = await open();
    await migrate(t.db);
    expect(await pendingMigrations(t.db)).toEqual([]);
    const P = '00000000-0000-0000-0000-000000000001';
    await runTransaction(t.db, async ({ emit }) => { emit({ projectId: P, kind: 'note', actor: 'a', actorRole: 'developer' }); });
    await expect(runTransaction(t.db, async ({ emit }) => {
      emit({ projectId: P, kind: 'note', actor: 'a', actorRole: 'developer' });
      throw new Error('nope');
    })).rejects.toThrow('nope');
    const r = await t.sql`select id, kind from taskgraph.events`;
    expect(r).toHaveLength(1);
    expect(typeof r[0].id).toBe('string'); // bigint ids stay exact
  });

  it('runs a transaction at the isolation level asked for', async () => {
    const t = await open();
    const iso = await t.db.transaction().setIsolationLevel('serializable').execute(async tx =>
      (await sql<{ iso: string }>`select current_setting('transaction_isolation') as iso`.execute(tx)).rows[0].iso);
    expect(iso).toBe('serializable');
  });

  it('keeps the SQLSTATE on driver errors, so the runner retries a deadlock', async () => {
    const t = await open();
    let runs = 0;
    await runTransaction(t.db, async ({ db }) => {
      if (++runs === 1) await sql.raw(`do $$ begin raise exception 'x' using errcode = '40P01'; end $$`).execute(db);
    }, { sleep: async () => {} });
    expect(runs).toBe(2);
  });
});
