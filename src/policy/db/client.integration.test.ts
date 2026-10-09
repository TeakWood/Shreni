import { describe, it, expect, onTestFinished } from 'vitest';
import postgres from 'postgres';
import { freshDatabase } from '../../taskgraph/test/postgres';
import { testLifecycle } from '../../taskgraph/test/lifecycle';
import { openShreni } from './client';

// The acceptance criterion on real Postgres, through postgres.js.

describe('Shreni\'s migrations on real Postgres', () => {
  it('create both schemas on an empty database, and a second run does nothing', async () => {
    const url = await freshDatabase();
    const sql = postgres(url, { max: 4, onnotice: () => {} });
    const shreni = await openShreni({ sql, lifecycle: testLifecycle() });
    onTestFinished(async () => { await shreni.close(); await sql.end({ timeout: 1 }); });
    const first = await shreni.migrate();
    expect(first.shreni).toEqual(['0001_tables']);
    const schemas = await sql`select schema_name from information_schema.schemata where schema_name in ('taskgraph', 'shreni') order by 1`;
    expect(schemas.map(r => r.schema_name)).toEqual(['shreni', 'taskgraph']);
    const tables = await sql`select table_name from information_schema.tables where table_schema = 'shreni' order by 1`;
    expect(tables.map(r => r.table_name)).toEqual([
      'acceptance_checks', 'attempt_evidence', 'intents', 'kysely_migration', 'kysely_migration_lock', 'memories', 'projects', 'schema_meta',
    ]);
    expect(await shreni.migrate()).toMatchObject({ engine: { applied: [] }, shreni: [] });
  });
});
