import { Kysely } from 'kysely';
import type postgres from 'postgres';
import {
  openTaskGraph, PostgresJsDialect, type Lifecycle, type MigrationReport, type TaskGraphClient, type Validator,
  type ValidatorConfig,
} from '../../taskgraph';
import { sql, type Transaction } from 'kysely';
import { migrateShreni, pendingShreniMigrations, SHRENI_VERSION, SHRENI_WRITER_SETTING } from './migrate';
import { ShreniSchemaBehind } from './errors';
import type { ShreniDatabase } from './schema';

export { ShreniSchemaBehind } from './errors';

// Shreni's database client (policy spec, "Shreni's tables"): one per process,
// the engine's client opened with Shreni's lifecycle and validators, plus a
// Kysely instance over the same pool for Shreni's own tables.

export interface OpenShreniOptions {
  /** The caller's postgres.js pool. Give this or `db`. */
  sql?: postgres.Sql;
  /** A direct connection for session locks and LISTEN (engine spec, "Connections"). */
  session?: postgres.Sql;
  /** A Kysely instance instead, as tests do over PGlite. */
  db?: Kysely<any>;
  lifecycle: Lifecycle;
  validators?: Validator[];
  validatorConfig?: ValidatorConfig;
}

export interface ShreniClient {
  /** The engine's client. */
  tg: TaskGraphClient;
  /** Shreni's tables, typed, for reads; queries share the engine's pool. */
  db: Kysely<ShreniDatabase>;
  /**
   * A transaction for writes to Shreni's tables, marked with this process's
   * writer version, so the schema's fence refuses a Shreni older than its
   * min_writer (raised as ShreniSchemaBehind).
   */
  transaction<T>(fn: (tx: Transaction<ShreniDatabase>) => Promise<T>): Promise<T>;
  /** Applies pending migrations, the engine's first; run only when asked. */
  migrate(): Promise<{ engine: MigrationReport; shreni: string[] }>;
  /** Shreni's migrations the database lacks. */
  pending(): Promise<string[]>;
  close(): Promise<void>;
}

export async function openShreni(options: OpenShreniOptions): Promise<ShreniClient> {
  if (!!options.sql === !!options.db) throw new TypeError('openShreni takes exactly one of sql or db');
  const db = (options.db ?? new Kysely<any>({ dialect: new PostgresJsDialect({ sql: options.sql! }) })) as Kysely<ShreniDatabase>;
  const tg = await openTaskGraph({
    ...(options.sql ? { sql: options.sql } : { db: options.db! }),
    session: options.session,
    lifecycle: options.lifecycle,
    validators: options.validators,
    validatorConfig: options.validatorConfig,
  });
  return {
    tg,
    db,
    async migrate() {
      const engine = await tg.migrate();
      return { engine, shreni: await migrateShreni(db) };
    },
    pending: () => pendingShreniMigrations(db),
    async transaction(fn) {
      try {
        return await db.transaction().execute(async tx => {
          await sql`select set_config(${SHRENI_WRITER_SETTING}, ${String(SHRENI_VERSION)}, true)`.execute(tx);
          return fn(tx);
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'SH001') throw new ShreniSchemaBehind((err as Error).message);
        throw err;
      }
    },
    async close() {
      await tg.close();
      // A Kysely Shreni made over the caller's pool owns nothing to end.
    },
  };
}
