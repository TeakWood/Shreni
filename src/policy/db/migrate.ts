import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import { SHRENI_MIGRATIONS, type ShreniMigration } from './migrations';
import { ShreniSchemaBehind } from './errors';

export { SHRENI_MIGRATIONS };

// Shreni's schema migrations (policy spec, "Schema migrations in practice"):
// run only when asked, after the engine's, all pending ones in one
// transaction under an advisory lock, with the bookkeeping in
// shreni.kysely_migration.

/** This process's Shreni writer version: the newest migration its code carries. */
export const SHRENI_VERSION = SHRENI_MIGRATIONS[SHRENI_MIGRATIONS.length - 1].version;
/** The setting every Shreni write sets to SHRENI_VERSION, for the fence trigger. */
export const SHRENI_WRITER_SETTING = 'shreni.writer_version';

/** Shreni's own migration lock; the engine's is 74_670_001. */
const MIGRATE_LOCK = 74_670_101;

async function applied(db: Kysely<any>): Promise<string[]> {
  const exists = await sql<{ t: string | null }>`select to_regclass('shreni.kysely_migration')::text as t`.execute(db);
  if (exists.rows[0].t === null) return [];
  return (await sql<{ name: string }>`select name from shreni.kysely_migration order by name`.execute(db)).rows.map(r => r.name);
}

/** The migrations this code carries that the database hasn't applied, oldest first. */
export async function pendingShreniMigrations(db: Kysely<any>): Promise<string[]> {
  const done = new Set(await applied(db));
  return SHRENI_MIGRATIONS.filter(m => !done.has(m.name)).map(m => m.name);
}

/**
 * Applies Shreni's pending migrations; returns their names. The engine's
 * schema must be there first: Shreni's tables reference it.
 */
export async function migrateShreni(
  db: Kysely<any>, migrations: readonly ShreniMigration[] = SHRENI_MIGRATIONS,
): Promise<string[]> {
  return db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(${MIGRATE_LOCK}, 0)`.execute(trx);
    const engine = await sql<{ t: string | null }>`select to_regclass('taskgraph.projects')::text as t`.execute(trx);
    if (engine.rows[0].t === null) throw new ShreniSchemaBehind('the engine\'s schema (taskgraph) isn\'t migrated; run its migrations first');
    // A schema migrated by a newer Shreni carries names this code doesn't know:
    // nothing is left for this process to apply.
    const done = await applied(trx);
    const known = new Set(migrations.map(m => m.name));
    if (done.some(name => !known.has(name))) {
      const missing = migrations.find(m => !done.includes(m.name));
      if (missing) throw new ShreniSchemaBehind(`migration ${missing.name} is missing from a newer schema`);
      return [];
    }
    await sql`create schema if not exists shreni`.execute(trx);
    const migrator = new Migrator({
      db: trx,
      migrationTableSchema: 'shreni',
      migrationTableName: 'kysely_migration',
      migrationLockTableName: 'kysely_migration_lock',
      allowUnorderedMigrations: true,
      provider: {
        async getMigrations() {
          return Object.fromEntries(migrations.map((m): [string, Migration] => [m.name, {
            async up(tx) {
              await sql`select set_config(${SHRENI_WRITER_SETTING}, ${String(SHRENI_VERSION)}, true)`.execute(tx);
              await m.up(tx);
              // version advances; min_writer rises only for a breaking migration
              await sql`
                insert into shreni.schema_meta (version, min_writer) values (${m.version}, ${m.minWriter ?? 1})
                on conflict (only_row) do update set
                  version    = excluded.version,
                  min_writer = greatest(shreni.schema_meta.min_writer, ${m.minWriter ?? 0})`.execute(tx);
            },
          }]));
        },
      },
    });
    const { error, results = [] } = await migrator.migrateToLatest();
    if (error) throw error;
    return results.filter(r => r.status === 'Success').map(r => r.migrationName);
  });
}
