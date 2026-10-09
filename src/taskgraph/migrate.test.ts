import { describe, it, expect, onTestFinished } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { sql } from 'kysely';
import { testDefinitionSql } from './test/lifecycle';
import { createTestDb, PGLITE_TIMEOUT, type TestDb } from './test/pglite';
import { migrate, pendingMigrations, requireMigration, setWriterVersion, ENGINE_VERSION } from './migrate';
import { MIGRATIONS, type EngineMigration } from './migrations';
import { SchemaBehind, TaskGraphError } from './errors';

async function openDb(): Promise<TestDb> {
  const t = await createTestDb();
  onTestFinished(() => t.close());
  return t;
}

async function rows<T>(t: TestDb, text: string): Promise<T[]> {
  return (await t.pglite.query<T>(text)).rows;
}

describe('migrate', { timeout: PGLITE_TIMEOUT }, () => {
  it('applies every migration to an empty database, and nothing on a second run', async () => {
    const t = await openDb();
    const first = await migrate(t.db);
    expect(first.applied).toEqual(MIGRATIONS.map(m => m.name));
    expect(first.version).toBe(ENGINE_VERSION);

    const second = await migrate(t.db);
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(ENGINE_VERSION);

    expect(await rows(t, 'select version, min_writer from taskgraph.schema_meta')).toEqual([
      { version: ENGINE_VERSION, min_writer: 1 },
    ]);
    expect(await rows(t, 'select name from taskgraph.kysely_migration order by name')).toEqual(
      MIGRATIONS.map(m => ({ name: m.name })),
    );
  });

  it('creates every engine table and index in the taskgraph schema', async () => {
    const t = await openDb();
    await migrate(t.db);
    const tables = await rows<{ table_name: string }>(
      t,
      `select table_name from information_schema.tables where table_schema = 'taskgraph' order by table_name`,
    );
    expect(tables.map(r => r.table_name)).toEqual(
      expect.arrayContaining([
        'schema_meta', 'lifecycles', 'projects', 'plans', 'tasks', 'task_deps',
        'task_links', 'attempts', 'events', 'purges', 'kysely_migration',
      ]),
    );
    const indexes = await rows<{ indexname: string }>(
      t,
      `select indexname from pg_indexes where schemaname = 'taskgraph'`,
    );
    expect(indexes.map(r => r.indexname)).toEqual(
      expect.arrayContaining([
        'tasks_ready', 'tasks_leases', 'tasks_parent', 'tasks_search', 'deps_reverse',
        'links_reverse', 'attempts_task', 'events_project', 'events_task', 'events_request',
      ]),
    );
  });

  it('installs taskgraph.now(), which tests can move with taskgraph.fake_now', async () => {
    const t = await openDb();
    await migrate(t.db);
    await t.db.transaction().execute(async tx => {
      await sql`set local taskgraph.fake_now = '2026-10-03T12:00:00Z'`.execute(tx);
      const r = await sql<{ now: Date }>`select taskgraph.now() as now`.execute(tx);
      expect(r.rows[0].now.toISOString()).toBe('2026-10-03T12:00:00.000Z');
    });
    const real = await sql<{ drift: number }>`
      select abs(extract(epoch from taskgraph.now() - now()))::float as drift`.execute(t.db);
    expect(real.rows[0].drift).toBe(0);
  });

  it('enforces the data model constraints the spec sketches', async () => {
    const t = await openDb();
    await migrate(t.db);
    await t.pglite.exec(`
      insert into taskgraph.lifecycles (name, version, definition, hash) values ('l', 1, ${testDefinitionSql()}, 'h');
      insert into taskgraph.projects (id, name, id_prefix, lifecycle_name, lifecycle_version)
        values ('00000000-0000-0000-0000-000000000001', 'web', 'web', 'l', 1);
    `);
    // origin 'plan' requires a plan id
    await expect(t.pglite.exec(`
      insert into taskgraph.tasks (project_id, id, kind, title, state, origin)
        values ('00000000-0000-0000-0000-000000000001', 'web-abc', 'work', 't', 'proposed', 'plan')
    `)).rejects.toThrow(/check/i);
    // the search column covers the description
    await t.pglite.exec(`
      insert into taskgraph.tasks (project_id, id, kind, title, description, state, origin)
        values ('00000000-0000-0000-0000-000000000001', 'web-abc', 'work', 't', 'zebra crossing', 'proposed', 'manual')
    `);
    expect(await rows(t, `select id from taskgraph.tasks where search @@ to_tsquery('simple', 'zebra')`))
      .toEqual([{ id: 'web-abc' }]);
    // schema_meta holds exactly one row
    await expect(t.pglite.exec(`insert into taskgraph.schema_meta (only_row, version, min_writer) values (false, 1, 1)`))
      .rejects.toThrow();
  });

  it('leaves a schema migrated by a newer engine alone', async () => {
    const t = await openDb();
    await migrate(t.db);
    await t.pglite.exec(
      `insert into taskgraph.kysely_migration (name, timestamp) values ('9999_from_the_future', now()::text)`,
    );
    const report = await migrate(t.db);
    expect(report.applied).toEqual([]);
  });
});

const core = MIGRATIONS[0];
function fake(version: number, slug: string, extra: Partial<EngineMigration> = {}): EngineMigration {
  const name = `${String(version).padStart(4, '0')}_${slug}`;
  return { version, name, up: async db => { await sql.raw(`create table taskgraph.t_${slug} (id int)`).execute(db); }, ...extra };
}

describe('schema_meta across migrations', { timeout: PGLITE_TIMEOUT }, () => {
  it('advances version on every migration, and raises min_writer only for a breaking one', async () => {
    const t = await openDb();
    const meta = () => rows(t, 'select version, min_writer from taskgraph.schema_meta');
    const added = fake(2, 'added');
    const breaking = fake(3, 'breaking', { minWriter: 3 });
    const later = fake(4, 'later');

    await migrate(t.db, [core, added]);
    expect(await meta()).toEqual([{ version: 2, min_writer: 1 }]);
    await migrate(t.db, [core, added, breaking]);
    expect(await meta()).toEqual([{ version: 3, min_writer: 3 }]);
    const report = await migrate(t.db, [core, added, breaking, later]);
    expect(report).toEqual({ applied: ['0004_later'], version: 4, minWriter: 3 });
  });

  it('applies pending migrations all or nothing', async () => {
    const t = await openDb();
    const boom = fake(2, 'boom', { up: async () => { throw new Error('boom'); } });
    await expect(migrate(t.db, [core, boom])).rejects.toThrow('boom');
    expect(await rows(t, `select to_regclass('taskgraph.schema_meta')::text as t`)).toEqual([{ t: null }]);
    expect(await pendingMigrations(t.db)).toEqual(MIGRATIONS.map(m => m.name));
  });

  it('refuses with SchemaBehind when a newer schema lacks one of this code\'s migrations', async () => {
    const t = await openDb();
    await migrate(t.db, [core]);
    await t.pglite.exec(
      `insert into taskgraph.kysely_migration (name, timestamp) values ('9999_from_the_future', now()::text)`,
    );
    const err = await migrate(t.db, [core, fake(2, 'mine')]).catch(e => e);
    expect(err).toBeInstanceOf(SchemaBehind);
    expect(err.migration).toBe('0002_mine');
  });
});

describe('the migration list', { timeout: PGLITE_TIMEOUT }, () => {
  it('numbers migrations 1..n, each name prefixed with its zero-padded version', () => {
    MIGRATIONS.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
      expect(m.name.startsWith(String(m.version).padStart(4, '0') + '_')).toBe(true);
    });
    expect(ENGINE_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('migrates from a single bundled file, with no migrations folder on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskgraph-bundle-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const outfile = join(dir, 'engine.cjs');
    await build({
      entryPoints: [join(__dirname, 'migrate.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      logLevel: 'silent',
    });
    // Run from the temp dir, so a provider reading a folder relative to cwd or
    // to the bundle would find none. Only PGlite, which loads its own wasm,
    // comes from the repo's node_modules.
    const repoRequire = createRequire(__filename);
    const script = `
      const { PGlite } = require(${JSON.stringify(repoRequire.resolve('@electric-sql/pglite'))});
      const { Kysely, PGliteDialect } = require(${JSON.stringify(repoRequire.resolve('kysely'))});
      const { migrate } = require('./engine.cjs');
      (async () => {
        const db = new Kysely({ dialect: new PGliteDialect({ pglite: await PGlite.create() }) });
        const first = await migrate(db);
        const second = await migrate(db);
        await db.destroy();
        process.stdout.write(JSON.stringify([first.applied, second.applied]));
      })().catch(e => { console.error(e); process.exit(1); });`;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { cwd: dir });
    expect(readdirSync(dir)).toEqual(['engine.cjs']);
    expect(JSON.parse(stdout)).toEqual([MIGRATIONS.map(m => m.name), []]);
  });
});

describe('writer version', { timeout: PGLITE_TIMEOUT }, () => {
  it('sets the engine version for the current transaction only', async () => {
    const t = await openDb();
    await t.db.transaction().execute(async tx => {
      await setWriterVersion(tx);
      const r = await sql<{ v: string }>`select current_setting('taskgraph.engine_version', true) as v`.execute(tx);
      expect(r.rows[0].v).toBe(String(ENGINE_VERSION));
    });
    const after = await sql<{ v: string | null }>`
      select nullif(current_setting('taskgraph.engine_version', true), '') as v`.execute(t.db);
    expect(after.rows[0].v).toBeNull();
  });
});

describe('SchemaBehind', { timeout: PGLITE_TIMEOUT }, () => {
  it('names the pending migration a call needs, until migrate runs', async () => {
    const t = await openDb();
    expect(await pendingMigrations(t.db)).toEqual(MIGRATIONS.map(m => m.name));

    const err = await requireMigration(t.db, '0001_core').catch(e => e);
    expect(err).toBeInstanceOf(SchemaBehind);
    expect(err).toBeInstanceOf(TaskGraphError);
    expect(err.code).toBe('SchemaBehind');
    expect(err.migration).toBe('0001_core');
    expect(err.message).toContain('0001_core');

    await migrate(t.db);
    expect(await pendingMigrations(t.db)).toEqual([]);
    await expect(requireMigration(t.db, '0001_core')).resolves.toBeUndefined();
  });
});
