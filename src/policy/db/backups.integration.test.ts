import { describe, it, expect, onTestFinished } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import postgres from 'postgres';
import { freshDatabase } from '../../taskgraph/test/postgres';
import { openShreni } from './client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { pgTools, takeDump } from './backups';

// A dump and a restore with the real pg_dump and pg_restore, over both schemas:
// work done after the dump is gone once it is restored.

const hasTools = (() => {
  try {
    execFileSync('pg_dump', ['--version']);
    execFileSync('pg_restore', ['--version']);
    execFileSync('psql', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTools)('backups on real Postgres', () => {
  it('restores a dump over later work, both schemas', async () => {
    const url = await freshDatabase();
    const sql = postgres(url, { max: 4, onnotice: () => {} });
    const shreni = await openShreni({ sql, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await sql.end({ timeout: 1 }); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'ann', role: 'developer' } });
    const tg = shreni.tg.project(p.id);
    const sys = tg.as({ id: 's', role: 'system' });
    await sys.tasks.create({ title: 'before the dump' });
    await shreni.transaction(db => db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'kept' }).execute());

    // The test server is on this machine's Docker; the dump is local.
    const target = { name: 'test', url };
    const file = await takeDump(target, 'manual', pgTools, { dir: mkdtempSync(join(tmpdir(), 'shreni-dump-')) });
    await sys.tasks.create({ title: 'after the dump' });
    await shreni.transaction(db => db.deleteFrom('shreni.memories').execute());
    // What a later migration adds: a table, and a key into one the dump holds,
    // which pg_restore --clean could neither drop nor step around.
    await sql`create table taskgraph.added (id int primary key, project_id uuid references taskgraph.projects(id))`;
    await sql`insert into taskgraph.added values (1, ${p.id})`;

    await shreni.close();
    await sql.end({ timeout: 1 });
    await pgTools.restore(target, file!);

    const again = postgres(url, { max: 2, onnotice: () => {} });
    const after = await openShreni({ sql: again, lifecycle: taskLifecycle });
    onTestFinished(async () => { await after.close(); await again.end({ timeout: 1 }); });
    expect((await after.tg.project(p.id).tasks.list({})).map(t => t.title)).toEqual(['before the dump']);
    expect(await after.db.selectFrom('shreni.memories').select('content').execute()).toEqual([{ content: 'kept' }]);
    expect((await again`select to_regclass('taskgraph.added')::text as t`)[0].t).toBeNull();
  });

  it('a dump of a database without Shreni\'s schemas restores to one without them', async () => {
    const url = await freshDatabase();
    const sql = postgres(url, { max: 2, onnotice: () => {} });
    onTestFinished(async () => { await sql.end({ timeout: 1 }); });
    const target = { name: 'test', url };
    const file = await takeDump(target, 'pre-import', pgTools, { dir: mkdtempSync(join(tmpdir(), 'shreni-dump-')) });
    await sql`create schema taskgraph`;
    await sql`create table taskgraph.t (id int)`;
    await pgTools.restore(target, file!);
    expect((await sql`select to_regnamespace('taskgraph')::text as s`)[0].s).toBeNull();
  });

  it('a restore that fails leaves the database as it was', async () => {
    const url = await freshDatabase();
    const sql = postgres(url, { max: 2, onnotice: () => {} });
    onTestFinished(async () => { await sql.end({ timeout: 1 }); });
    await sql`create schema taskgraph`;
    await sql`create table taskgraph.t (id int primary key)`;
    await sql`insert into taskgraph.t values (1)`;
    const target = { name: 'test', url };
    const file = await takeDump(target, 'manual', pgTools, { dir: mkdtempSync(join(tmpdir(), 'shreni-dump-')) });
    await sql`insert into taskgraph.t values (2)`;
    // The load fails after the drop: an event trigger refuses every CREATE TABLE.
    await sql`create schema other`;
    await sql`create function other.refuse() returns event_trigger language plpgsql as $$ begin raise exception 'no'; end $$`;
    await sql`create event trigger refuse on ddl_command_end when tag in ('CREATE TABLE') execute function other.refuse()`;
    onTestFinished(async () => { await sql`drop event trigger if exists refuse`.catch(() => {}); });
    await expect(pgTools.restore(target, file!)).rejects.toThrow(/psql failed/);
    await sql`drop event trigger refuse`;
    expect((await sql`select id from taskgraph.t order by id`).map(r => r.id)).toEqual([1, 2]);
  });
});
