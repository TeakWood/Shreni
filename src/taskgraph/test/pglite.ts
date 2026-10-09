import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres from 'postgres';
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

/** A postgres.js client talking to PGlite over the Postgres wire protocol. */
export interface WireDb {
  pglite: PGlite;
  sql: postgres.Sql;
  /** Another postgres.js instance on the same server; closed with it. */
  connect(options?: postgres.Options<{}>): postgres.Sql;
  close(): Promise<void>;
}

/**
 * Serves a fresh PGlite on a free local port and connects postgres.js to it,
 * to drive the engine through the driver it uses in production. PGlite serves
 * one connection, so the client's pool holds one.
 */
export async function createWireTestDb(connections = 1): Promise<WireDb> {
  const pglite = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0, maxConnections: connections });
  await server.start();
  const conn = server.getServerConn();
  const port = Number(conn.slice(conn.lastIndexOf(':') + 1));
  const sql = postgres({ host: '127.0.0.1', port, max: connections, onnotice: () => {} });
  const others: postgres.Sql[] = [];
  return {
    pglite,
    sql,
    connect(options = {}) {
      const s = postgres({ host: '127.0.0.1', port, onnotice: () => {}, ...options });
      others.push(s);
      return s;
    },
    async close() {
      for (const s of others) await s.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await server.stop();
      if (!pglite.closed) await pglite.close();
    },
  };
}
