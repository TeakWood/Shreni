import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';

// In-process Postgres for the engine's unit tests (engine spec, "Testing": the
// unit tier). Each call gets a fresh in-memory database, so tests never share
// state. PGlite runs a single connection, so contention between workers belongs
// to the concurrency tier, not here.

export interface TestDb<DB = any> {
  /** The raw PGlite instance, for SQL the query builder doesn't cover. */
  pglite: PGlite;
  /** A Kysely client over the same database. */
  db: Kysely<DB>;
  /** Destroys the Kysely client and closes PGlite. */
  close(): Promise<void>;
}

export async function createTestDb<DB = any>(): Promise<TestDb<DB>> {
  const pglite = await PGlite.create();
  const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) });
  return {
    pglite,
    db,
    // Kysely's PGlite driver closes the instance on destroy; guard the extra close.
    async close() {
      await db.destroy();
      if (!pglite.closed) await pglite.close();
    },
  };
}
