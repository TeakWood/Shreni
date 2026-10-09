import { describe, it, expect, onTestFinished } from 'vitest';
import { createTestDb, createWireTestDb, PGLITE_TIMEOUT, type TestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph, type TaskGraphClient } from './client';
import { LifecycleInvalid, NotFound, NotPermitted, SchemaBehind, VersionMismatch } from './errors';
import { lifecycleHash } from './lifecycle';
import { MIGRATIONS } from './migrations';

const ann = { id: 'ann', role: 'developer' };

async function openClient(lifecycle = testLifecycle()): Promise<{ t: TestDb; client: TaskGraphClient }> {
  const t = await createTestDb();
  const client = await openTaskGraph({ db: t.db, lifecycle });
  onTestFinished(async () => { await client.close(); await t.close(); });
  return { t, client };
}

describe('openTaskGraph', { timeout: PGLITE_TIMEOUT }, () => {
  it('opens on an unmigrated database, and refuses calls with SchemaBehind until migrate runs', async () => {
    const { client } = await openClient();
    const err = await client.projects.list().catch(e => e);
    expect(err).toBeInstanceOf(SchemaBehind);
    expect(err.migration).toBe('0001_core');

    const report = await client.migrate();
    expect(report.applied).toEqual(MIGRATIONS.map(m => m.name));
    expect(await client.projects.list()).toEqual([]);
  });

  it('sees a migration another process ran', async () => {
    const { t, client } = await openClient();
    const other = await openTaskGraph({ db: t.db, lifecycle: testLifecycle() });
    await other.migrate();
    expect(await client.projects.list()).toEqual([]);
  });

  it('refuses a postgres.js instance that transforms rows', async () => {
    const postgres = (await import('postgres')).default;
    const camel = postgres({ transform: postgres.camel });
    onTestFinished(() => camel.end({ timeout: 0 }));
    await expect(openTaskGraph({ sql: camel, lifecycle: testLifecycle() })).rejects.toThrow(/transforms/);
  });

  it('registers its lifecycle once the schema is there', async () => {
    const { t, client } = await openClient();
    await client.migrate();
    const rows = (await t.pglite.query(`select name, version, hash from taskgraph.lifecycles`)).rows;
    expect(rows).toEqual([{ name: 'test.task', version: 1, hash: lifecycleHash(testLifecycle()) }]);
  });

  it('refuses to open with a changed lifecycle under a registered version', async () => {
    const { t, client } = await openClient();
    await client.migrate();
    const changed = testLifecycle();
    changed.moves = changed.moves.filter(m => m.name !== 'park');
    await expect(openTaskGraph({ db: t.db, lifecycle: changed })).rejects.toBeInstanceOf(LifecycleInvalid);
  });

  it('opens over a postgres.js instance', async () => {
    const w = await createWireTestDb();
    const client = await openTaskGraph({ sql: w.sql, lifecycle: testLifecycle() });
    onTestFinished(async () => { await client.close(); await w.close(); });
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    expect((await client.projects.get(p.id)).name).toBe('web');

    // arrays, json and timestamps through the production driver
    const as = client.project(p.id).as(ann);
    const hold = new Date('2026-11-01T00:00:00Z');
    const task = await as.tasks.create({ title: 't', tags: ['a', 'b'], spec: { checks: [1] }, holdUntil: hold });
    expect(task).toMatchObject({ tags: ['a', 'b'], spec: { checks: [1] }, holdUntil: hold, state: 'proposed' });
    const other = await as.tasks.create({ title: 'u' });
    await as.deps.add(task.id, other.id);
    expect(await as.tasks.update(task.id, { tags: [], holdUntil: null })).toMatchObject({ tags: [], holdUntil: null });
    // json is stored as objects, not as strings holding json
    const kinds = await w.sql`
      select (select jsonb_typeof(definition) from taskgraph.lifecycles) as definition,
             (select jsonb_typeof(payload) from taskgraph.events where kind = 'task.updated') as payload,
             (select jsonb_typeof(spec) from taskgraph.tasks where id = ${task.id}) as spec`;
    expect([...kinds]).toEqual([{ definition: 'object', payload: 'object', spec: 'object' }]);
  });
});

describe('projects', { timeout: PGLITE_TIMEOUT }, () => {
  it('are created on the lifecycle\'s registered version, keyed by a uuid, with an event', async () => {
    const { t, client } = await openClient();
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    expect(p).toMatchObject({ name: 'web', idPrefix: 'web', lifecycleName: 'test.task', lifecycleVersion: 1 });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(await client.projects.get(p.id)).toEqual(p);

    const events = (await t.pglite.query(`select project_id, kind, actor, actor_role, payload from taskgraph.events`)).rows;
    expect(events).toEqual([{ project_id: p.id, kind: 'project.created', actor: 'ann', actor_role: 'developer', payload: { name: 'web', idPrefix: 'web' } }]);
  });

  it('need not have unique names, and list oldest first', async () => {
    const { client } = await openClient();
    await client.migrate();
    const a = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    const b = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    expect((await client.projects.list()).map(p => p.id)).toEqual([a.id, b.id]);
  });

  it('throw NotFound for an unknown id', async () => {
    const { client } = await openClient();
    await client.migrate();
    await expect(client.projects.get('00000000-0000-0000-0000-00000000dead')).rejects.toBeInstanceOf(NotFound);
    expect(() => client.project('not-a-uuid')).toThrow(NotFound);
  });
});

describe('project handles and actors', { timeout: PGLITE_TIMEOUT }, () => {
  it('check an actor\'s calls against the lifecycle\'s permissions', async () => {
    const { client } = await openClient();
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    const tg = client.project(p.id);
    expect(tg.id).toBe(p.id);
    const as = tg.as({ id: 'bot', role: 'planner' });
    expect(as.actor).toEqual({ id: 'bot', role: 'planner' });
    await expect(as.check('tasks.update', 'proposed')).resolves.toBeUndefined();
    await expect(as.check('notes.add', 'open')).rejects.toBeInstanceOf(NotPermitted);
  });

  it('refuse checks for a project on another lifecycle version with VersionMismatch', async () => {
    const { t, client } = await openClient();
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    const v2 = testLifecycle();
    v2.version = 2;
    const newer = await openTaskGraph({ db: t.db, lifecycle: v2 });
    await expect(newer.project(p.id).as(ann).check('notes.add', 'open')).rejects.toBeInstanceOf(VersionMismatch);
  });

  it('normalise the project uuid', async () => {
    const { client } = await openClient();
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    expect(client.project(p.id.toUpperCase()).id).toBe(p.id);
  });

  it('refuse an actor with no id or role', async () => {
    const { client } = await openClient();
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    expect(() => client.project(p.id).as({ id: '', role: 'developer' })).toThrow(TypeError);
    expect(() => client.project(p.id).as({ id: 'x', role: '' })).toThrow(TypeError);
  });
});
