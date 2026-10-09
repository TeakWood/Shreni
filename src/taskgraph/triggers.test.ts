import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { openEngine } from './test/engine';
import { testLifecycle } from './test/lifecycle';
import { registerLifecycle } from './lifecycle';
import { openTaskGraph } from './client';
import { runTransaction } from './tx';
import { InvalidRequest, SchemaBehind, VersionMismatch } from './errors';
import { createTestDb } from './test/pglite';
import { migrate } from './migrate';
import { MIGRATIONS } from './migrations';

describe('the tasks trigger', { timeout: 30_000 }, () => {
  it('refuses raw SQL setting a state no move reaches', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    // no move goes from proposed to done
    await expect(e.t.pglite.query(`update taskgraph.tasks set state = 'done' where id = $1`, [t.id])).rejects.toThrow(/no move/);
    await expect(e.t.pglite.query(`update taskgraph.tasks set state = 'zzz' where id = $1`, [t.id])).rejects.toThrow(/not a state/);
    // a declared move is allowed
    await e.t.pglite.query(`update taskgraph.tasks set state = 'open' where id = $1`, [t.id]);
  });

  it('refuses an insert outside the create rules, except while importing that project', async () => {
    const e = await openEngine();
    const insert = (id: string, state: string) => e.t.pglite.query(
      `insert into taskgraph.tasks (project_id, id, kind, title, state, origin) values ($1, $2, 'work', 't', $3, 'manual')`, [e.tg.id, id, state]);
    await insert('web-p01', 'proposed');
    await insert('web-o01', 'open'); // create.byRole names open
    await expect(insert('web-w01', 'waiting')).rejects.toThrow(/create/);
    await e.t.pglite.transaction(async tx => {
      await tx.query(`select set_config('taskgraph.importing', $1, true)`, [e.tg.id]);
      await tx.query(`insert into taskgraph.tasks (project_id, id, kind, title, state, origin) values ($1, 'web-w02', 'work', 't', 'waiting', 'imported')`, [e.tg.id]);
    });
  });

  it('refuses a lease on a task outside the leased state', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    await expect(e.t.pglite.query(
      `update taskgraph.tasks set lease_attempt_id = gen_random_uuid(), lease_expires_at = now() where id = $1`, [t.id],
    )).rejects.toThrow(/lease/);
  });

  it('refuses a write from a process on lifecycle version 1 once version 2 is active, with VersionMismatch', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    const v2 = testLifecycle();
    v2.version = 2;
    await registerLifecycle(e.t.db, v2);
    await e.t.pglite.query(`update taskgraph.projects set lifecycle_version = 2 where id = $1`, [e.tg.id]);

    // the old process's writes, raw SQL included, carry version 1
    const err = await runTransaction(e.t.db, async ({ db }) => {
      await sql`update taskgraph.tasks set title = 'x' where id = ${t.id}`.execute(db);
    }, { lifecycle: { name: 'test.task', version: 1 } }).catch(x => x);
    expect(err).toBeInstanceOf(VersionMismatch);
    await expect(e.as('planner').tasks.update(t.id, { title: 'x' })).rejects.toBeInstanceOf(VersionMismatch);

    // a process on version 2 writes
    const newer = await openTaskGraph({ db: e.t.db, lifecycle: v2 });
    expect(await newer.project(e.tg.id).as({ id: 'p', role: 'planner' }).tasks.update(t.id, { title: 'y' })).toMatchObject({ title: 'y' });
  });

  it('refuses a write from an engine older than the schema\'s min_writer, with VersionMismatch', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await e.t.pglite.query(`update taskgraph.schema_meta set min_writer = 999`);
    await expect(e.as('planner').tasks.update(t.id, { title: 'x' })).rejects.toBeInstanceOf(VersionMismatch);
  });

  it('fences every engine table, not just tasks', async () => {
    const e = await openEngine();
    const a = await e.as('planner').tasks.create({ title: 'a' });
    const b = await e.as('planner').tasks.create({ title: 'b' });
    await e.t.pglite.query(`update taskgraph.schema_meta set min_writer = 999`);
    const as = e.as('developer');
    await expect(as.notes.add(a.id, 'n')).rejects.toBeInstanceOf(VersionMismatch);
    await expect(as.deps.add(a.id, b.id)).rejects.toBeInstanceOf(VersionMismatch);
    await expect(as.links.add(a.id, b.id, 'related')).rejects.toBeInstanceOf(VersionMismatch);
    await expect(e.as('planner').tasks.delete(a.id)).rejects.toBeInstanceOf(VersionMismatch);
  });

  it('refuses a raw insert of an event from a process on another lifecycle version', async () => {
    const e = await openEngine();
    const err = await runTransaction(e.t.db, async ({ emit }) => {
      emit({ projectId: e.tg.id, kind: 'note', actor: 'x', actorRole: 'developer' });
    }, { lifecycle: { name: 'test.task', version: 7 } }).catch(x => x);
    expect(err).toBeInstanceOf(VersionMismatch);
  });

  it('refuses a raw delete of a task that has left the create state, except while purging', async () => {
    const e = await openEngine();
    const p = await e.as('planner').tasks.create({ title: 'p' });
    const o = await e.as('system').tasks.create({ title: 'o' });
    await expect(e.t.pglite.query(`delete from taskgraph.tasks where id = $1`, [o.id])).rejects.toThrow(/delete/);
    await e.t.pglite.query(`delete from taskgraph.tasks where id = $1`, [p.id]);
    await e.t.pglite.transaction(async tx => {
      await tx.query(`select set_config('taskgraph.purging', $1, true)`, [e.tg.id]);
      await tx.query(`delete from taskgraph.tasks where id = $1`, [o.id]);
    });
  });

  it('exempts only inserts while importing, never a state change', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await expect(e.t.pglite.transaction(async tx => {
      await tx.query(`select set_config('taskgraph.importing', $1, true)`, [e.tg.id]);
      await tx.query(`update taskgraph.tasks set state = 'done' where id = $1`, [t.id]);
    })).rejects.toThrow(/no move/);
  });

  it('surfaces a rule refusal inside an engine transaction as InvalidRequest', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    const err = await e.client.transaction(async ({ db }) => {
      await sql`update taskgraph.tasks set state = 'done' where id = ${t.id}`.execute(db);
    }).catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(/no move/);
  });
});

describe('a schema without the triggers', { timeout: 30_000 }, () => {
  it('refuses writes with SchemaBehind until migrated', async () => {
    const t = await createTestDb();
    try {
      await migrate(t.db, MIGRATIONS.slice(0, 1));
      const client = await openTaskGraph({ db: t.db, lifecycle: testLifecycle() });
      await expect(client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } }))
        .rejects.toBeInstanceOf(SchemaBehind);
      await client.migrate();
      await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    } finally {
      await t.close();
    }
  });
});

describe('the events trigger', { timeout: 30_000 }, () => {
  it('refuses updates and deletes, except deletes of the project being purged', async () => {
    const e = await openEngine();
    await e.as('planner').tasks.create({ title: 't' });
    await expect(e.t.pglite.query(`update taskgraph.events set actor = 'mallory'`)).rejects.toThrow(/append-only/);
    await expect(e.t.pglite.query(`delete from taskgraph.events`)).rejects.toThrow(/append-only/);
    await expect(e.t.pglite.query(`truncate taskgraph.events`)).rejects.toThrow(/append-only/);
    await e.t.pglite.transaction(async tx => {
      await tx.query(`select set_config('taskgraph.purging', $1, true)`, [e.tg.id]);
      await tx.query(`delete from taskgraph.events where project_id = $1`, [e.tg.id]);
    });
    expect(await e.rows(`select count(*)::int as n from taskgraph.events`)).toEqual([{ n: 0 }]);
  });
});
