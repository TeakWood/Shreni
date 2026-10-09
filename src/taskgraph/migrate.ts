import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import { MIGRATIONS, type EngineMigration } from './migrations';
import { SchemaBehind } from './errors';

// Schema migrations (engine spec, "Schema migrations"). They run only when the
// caller asks, all pending ones in one transaction under Kysely's migration
// lock, with the bookkeeping in taskgraph.kysely_migration.

/** This process's engine version: the newest migration its code carries. */
export const ENGINE_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const SCHEMA = 'taskgraph';
const TABLE = 'kysely_migration';

export interface MigrationReport {
  /** Migrations this call applied, oldest first; empty when none were pending. */
  applied: string[];
  /** schema_meta.version after the call. */
  version: number;
  /** schema_meta.min_writer after the call. */
  minWriter: number;
}

/**
 * Marks the current transaction's writes with this process's engine version,
 * which the backstop trigger checks against schema_meta.min_writer. Every write
 * transaction calls it first; it lasts until the transaction ends.
 */
export async function setWriterVersion(tx: Kysely<any>): Promise<void> {
  await sql`select set_config('taskgraph.engine_version', ${String(ENGINE_VERSION)}, true)`.execute(tx);
}

/**
 * Applies every pending migration, in one transaction under a taskgraph
 * advisory lock, so concurrent callers apply each migration once.
 *
 * Kysely's migrator also takes its own session lock, whose id every Kysely
 * migrator in the database shares: run this and the caller's own migrator one
 * after the other, never one inside the other on separate connections.
 *
 * `migrations` is for tests; callers use the default.
 */
export async function migrate(
  db: Kysely<any>,
  migrations: readonly EngineMigration[] = MIGRATIONS,
): Promise<MigrationReport> {
  return db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(hashtext('taskgraph:migrate'))`.execute(trx);

    // A schema migrated by a newer engine carries names this code doesn't know.
    // Kysely would call that corrupt; it is the expected state for an older
    // process, which can't have anything left to apply.
    const applied = await appliedMigrations(trx);
    const known = new Set(migrations.map(m => m.name));
    if (applied.some(name => !known.has(name))) {
      const missing = migrations.find(m => !applied.includes(m.name));
      if (missing) throw new SchemaBehind(missing.name);
      return { applied: [], ...(await readMeta(trx)) };
    }

    const migrator = new Migrator({
      db: trx,
      migrationTableSchema: SCHEMA,
      migrationTableName: TABLE,
      migrationLockTableName: `${TABLE}_lock`,
      // Kysely orders applied migrations by each client's own clock; on a shared
      // database a skewed clock would then read as out of order. The numbered,
      // append-only list already fixes the order.
      allowUnorderedMigrations: true,
      provider: {
        async getMigrations() {
          return Object.fromEntries(migrations.map((m): [string, Migration] => [m.name, {
            async up(tx) {
              await setWriterVersion(tx);
              await m.up(tx);
              // version advances; min_writer rises only for a breaking migration
              await sql`
                insert into taskgraph.schema_meta (version, min_writer)
                values (${m.version}, ${m.minWriter ?? 1})
                on conflict (only_row) do update set
                  version    = excluded.version,
                  min_writer = greatest(taskgraph.schema_meta.min_writer, ${m.minWriter ?? 0})`.execute(tx);
            },
          }]));
        },
      },
    });

    const { error, results = [] } = await migrator.migrateToLatest();
    if (error) throw error;
    return {
      applied: results.filter(r => r.status === 'Success').map(r => r.migrationName),
      ...(await readMeta(trx)),
    };
  });
}

/** The migrations this code carries that the database hasn't applied, oldest first. */
export async function pendingMigrations(db: Kysely<any>): Promise<string[]> {
  const applied = new Set(await appliedMigrations(db));
  return MIGRATIONS.filter(m => !applied.has(m.name)).map(m => m.name);
}

/** Throws SchemaBehind, naming the migration, unless it has been applied. */
export async function requireMigration(db: Kysely<any>, name: string): Promise<void> {
  if (!(await appliedMigrations(db)).includes(name)) throw new SchemaBehind(name);
}

async function appliedMigrations(db: Kysely<any>): Promise<string[]> {
  const exists = await sql<{ t: string | null }>`
    select to_regclass('taskgraph.kysely_migration')::text as t`.execute(db);
  if (exists.rows[0].t === null) return [];
  const r = await sql<{ name: string }>`select name from taskgraph.kysely_migration order by name`.execute(db);
  return r.rows.map(row => row.name);
}

async function readMeta(db: Kysely<any>): Promise<{ version: number; minWriter: number }> {
  const r = await sql<{ version: number; min_writer: number }>`
    select version, min_writer from taskgraph.schema_meta`.execute(db);
  return { version: r.rows[0].version, minWriter: r.rows[0].min_writer };
}
