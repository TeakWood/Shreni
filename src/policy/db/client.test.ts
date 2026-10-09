import { describe, it, expect, onTestFinished } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { testLifecycle } from '../../taskgraph/test/lifecycle';
import { openShreni, ShreniSchemaBehind } from './client';
import { migrateShreni, SHRENI_MIGRATIONS } from './migrate';

const SHRENI_TABLES = [
  'shreni.acceptance_checks', 'shreni.attempt_evidence', 'shreni.intents', 'shreni.kysely_migration',
  'shreni.kysely_migration_lock', 'shreni.memories', 'shreni.projects', 'shreni.schema_meta',
];

// Shreni's own tables (policy spec, "Shreni's tables"), in the shreni schema
// beside the engine's, migrated after it.

async function open() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: testLifecycle() });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  return { t, shreni, rows: async (q: string, p: unknown[] = []) => (await t.pglite.query<any>(q, p)).rows };
}

describe('openShreni().migrate', { timeout: PGLITE_TIMEOUT }, () => {
  it('on an empty database runs the engine\'s migrations, then Shreni\'s; a second run does nothing', async () => {
    const { shreni, rows } = await open();
    const first = await shreni.migrate();
    expect(first.engine.applied.length).toBeGreaterThan(0);
    expect(first.shreni).toEqual(SHRENI_MIGRATIONS.map(m => m.name));
    const tables = await rows(`select table_schema || '.' || table_name as t from information_schema.tables
                               where table_schema in ('shreni') order by 1`);
    expect(tables.map(r => r.t)).toEqual(SHRENI_TABLES);
    const second = await shreni.migrate();
    expect(second).toMatchObject({ engine: { applied: [] }, shreni: [] });
    expect(await shreni.pending()).toEqual([]);
  });

  it('refuses Shreni\'s migrations on a database the engine hasn\'t migrated', async () => {
    const { t } = await open();
    await expect(migrateShreni(t.db)).rejects.toBeInstanceOf(ShreniSchemaBehind);
  });
});

describe('Shreni\'s rows', { timeout: PGLITE_TIMEOUT }, () => {
  it('go with their project when the engine purges it', async () => {
    const { shreni, rows } = await open();
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const t = await shreni.tg.project(p.id).as({ id: 'pl', role: 'planner' }).tasks.create({ title: 't' });
    await shreni.transaction(async db => {
      await db.insertInto('shreni.projects').values({ project_id: p.id, mode: 'tracker' }).execute();
      await db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'remember this' }).execute();
      await db.insertInto('shreni.acceptance_checks')
        .values({ project_id: p.id, task_id: t.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute();
    });
    await shreni.tg.projects.purge(p.id, { actor: { id: 'a', role: 'developer' }, confirmName: 'web' });
    for (const table of ['projects', 'memories', 'acceptance_checks']) {
      expect(await rows(`select count(*)::int n from shreni.${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it('check their own rules: a mode, and a check on exactly one of a task or an intent', async () => {
    const { shreni } = await open();
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    await expect(shreni.db.insertInto('shreni.projects').values({ project_id: p.id, mode: 'other' }).execute()).rejects.toThrow();
    await expect(shreni.db.insertInto('shreni.acceptance_checks')
      .values({ project_id: p.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute()).rejects.toThrow();
  });
});

describe('review follow-ups (T4.3)', { timeout: PGLITE_TIMEOUT }, () => {
  it('purge takes intents, plan-level checks and attempt evidence too', async () => {
    const { shreni, rows } = await open();
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg = shreni.tg.project(p.id);
    const plan = await tg.as({ id: 'pl', role: 'planner' }).plans.create({ title: 'p' });
    await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 't' });
    const c = (await tg.as({ id: 'o', role: 'orchestrator' }).claim({ worker: 'w', leaseMs: 60_000 }))!;
    await shreni.transaction(async db => {
      await db.insertInto('shreni.intents').values({ project_id: p.id, plan_id: plan.id, statement: 'users log in' }).execute();
      await db.insertInto('shreni.acceptance_checks')
        .values({ project_id: p.id, plan_id: plan.id, given: 'g', when: 'w', then: 't', mode: 'manual' }).execute();
      await db.insertInto('shreni.attempt_evidence').values({ attempt_id: c.attemptId, rounds: [{ round: 1, verdict: 'reject' }] }).execute();
    });
    expect(await rows(`select rounds from shreni.attempt_evidence`)).toEqual([{ rounds: [{ round: 1, verdict: 'reject' }] }]);
    await shreni.tg.projects.purge(p.id, { actor: { id: 'a', role: 'developer' }, confirmName: 'web' });
    for (const table of ['intents', 'acceptance_checks', 'attempt_evidence']) {
      expect(await rows(`select count(*)::int n from shreni.${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it('fences Shreni writers older than the schema\'s min_writer', async () => {
    const { shreni, t } = await open();
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    await t.pglite.query(`update shreni.schema_meta set min_writer = 99`);
    await expect(shreni.transaction(db => db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'c' }).execute()))
      .rejects.toThrow(/older than|min_writer/);
  });

  it('a schema from a newer Shreni: unknown names leave nothing to apply; a missing known one is refused', async () => {
    const { shreni, t } = await open();
    await shreni.migrate();
    await t.pglite.query(`insert into shreni.kysely_migration (name, timestamp) values ('0099_future', now()::text)`);
    expect(await migrateShreni(t.db)).toEqual([]);
    await t.pglite.query(`delete from shreni.kysely_migration where name = '0001_tables'`);
    await expect(migrateShreni(t.db)).rejects.toBeInstanceOf(ShreniSchemaBehind);
  });

  it('takes exactly one of sql or db', async () => {
    const t = await createTestDb();
    onTestFinished(() => t.close());
    await expect(openShreni({ lifecycle: testLifecycle() })).rejects.toThrow(/exactly one/);
    await expect(openShreni({ db: t.db, sql: {} as never, lifecycle: testLifecycle() })).rejects.toThrow(/exactly one/);
  });
});
