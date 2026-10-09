import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { migrate } from '../migrate';

// In-process Postgres for the engine's unit tests (engine spec, "Testing": the
// unit tier). Each call gets a fresh in-memory database, so tests never share
// state. PGlite runs a single connection, so contention between workers belongs
// to the concurrency tier, not here.

/**
 * Per-test timeout for suites that boot PGlite: a cold boot takes about a second
 * alone, but several under a full parallel `pnpm vitest run`.
 */
export const PGLITE_TIMEOUT = 30_000;

export interface TestDb<DB = any> {
  /** The raw PGlite instance, for SQL the query builder doesn't cover. */
  pglite: PGlite;
  /** A Kysely client over the same database. */
  db: Kysely<DB>;
  /** Destroys the Kysely client and closes PGlite. */
  close(): Promise<void>;
}

function wrap<DB>(pglite: PGlite): TestDb<DB> {
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

export async function createTestDb<DB = any>(): Promise<TestDb<DB>> {
  return wrap<DB>(await PGlite.create());
}

// Booting and migrating PGlite takes about a second, so each worker migrates one
// template and hands out clones of it.
let template: Promise<PGlite> | undefined;

/** A fresh database with every engine migration applied. */
export async function createMigratedTestDb<DB = any>(): Promise<TestDb<DB>> {
  template ??= (async () => {
    const t = await createTestDb();
    await migrate(t.db);
    return t.pglite;
  })().catch(err => {
    template = undefined; // let the next test retry rather than reuse the failure
    throw err;
  });
  return wrap<DB>((await (await template).clone()) as PGlite);
}
