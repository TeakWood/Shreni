import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type postgres from 'postgres';
import { InvalidRequest, Unavailable } from './errors';

// The client's session connection (engine spec, "Connections"). LISTEN and
// session advisory locks need one connection that stays the same session;
// poolers in transaction mode can't give that, so the caller passes a
// postgres.js instance of its own for them, on a direct connection, with one
// connection and no max_lifetime, while queries use the pool. Postgres
// releases a session's locks when its connection closes, so a dead process
// frees what it held.
//
// Every session statement also returns pg_backend_pid(), so the client sees a
// reconnect in the same statement that runs on the new backend: the old
// session's locks are gone, and are marked lost; the statement's own result
// is the new session's. Statements run one at a time, so the bookkeeping
// never races.

/** Releases a session lock; calling it again does nothing. `held()` says whether the lock is still this session's. */
export type Release = (() => Promise<void>) & { held(): Promise<boolean> };

/** A 63-bit key for pg_advisory_lock(bigint), from the project and the name. */
export function lockKey(projectId: string, name: string): string {
  const h = createHash('sha256').update(`taskgraph.session\0${projectId}\0${name}`).digest();
  return (h.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn).toString();
}

type Row = { pid: number; ok: boolean };

const CONNECTION_CODES = new Set(['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03']);

export class Session {
  /** The backend the held locks live on. */
  private pid?: number;
  /** Lock key -> the token of the acquisition holding it. */
  private readonly held = new Map<string, object>();
  private closed = false;
  /** Every session operation runs after the one before it. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `dedicated`: the caller's postgres.js instance for the session. `db`: a
   * Kysely instance, used when there is none and the client wasn't given a
   * postgres.js pool (PGlite in tests, a single session already).
   */
  constructor(private readonly db: Kysely<any>, private readonly dedicated?: postgres.Sql, private readonly pooled = false) {
    if (dedicated) {
      // max can arrive as a string from a URL or the environment.
      const o = dedicated.options as { max?: number | string; max_lifetime?: unknown; idle_timeout?: unknown };
      if (Number(o.max) !== 1 || o.max_lifetime != null || (o.idle_timeout != null && o.idle_timeout !== 0)) {
        throw new InvalidRequest('the session instance needs max: 1, max_lifetime: null and no idle_timeout, so it stays one session');
      }
    }
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Runs `select pg_backend_pid() as pid, <expr> as ok`, the expression taking the lock key as $1. */
  private async exec(expr: string, key: string): Promise<boolean> {
    let row: Row;
    try {
      if (this.dedicated) {
        [row] = (await this.dedicated.unsafe(`select pg_backend_pid() as pid, ${expr} as ok`, [key])) as unknown as Row[];
      } else if (this.pooled) {
        throw new InvalidRequest('session locks need a session connection: pass openTaskGraph a session instance');
      } else {
        // PGlite: the only parameter is a key lockKey makes from digits, so it is inlined.
        if (!/^\d+$/.test(key)) throw new TypeError('taskgraph: a session lock key is digits');
        const r = await sql.raw(`select pg_backend_pid() as pid, ${expr.replace('$1', key)} as ok`).execute(this.db);
        row = r.rows[0] as Row;
      }
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      if (CONNECTION_CODES.has(code) || code.startsWith('08')) {
        throw new Unavailable('the session connection failed; locks held on it are gone if it was lost', err);
      }
      throw err;
    }
    if (this.pid !== undefined && row.pid !== this.pid) this.held.clear(); // a new session: the old one's locks went with it
    this.pid = row.pid;
    return row.ok;
  }

  /**
   * Takes the session advisory lock `name` for the project, or returns null
   * at once if any session holds it, this one included.
   */
  async trySession(projectId: string, name: string): Promise<Release | null> {
    if (!name) throw new InvalidRequest('a session lock needs a name');
    const key = lockKey(projectId, name);
    const token = {};
    const got = await this.serial(async () => {
      if (this.closed) throw new InvalidRequest('the client is closed');
      // Held here: look first, so a reconnect since the last statement is seen.
      if (this.held.has(key)) await this.exec('$1::bigint is null', key);
      if (this.held.has(key)) return false;
      const ok = await this.exec('pg_try_advisory_lock($1::bigint)', key);
      if (ok) this.held.set(key, token);
      return ok;
    });
    if (!got) return null;
    const mine = () => this.held.get(key) === token;
    const release = () => this.serial(async () => {
      if (!mine() || this.closed) return;
      this.held.delete(key);
      try {
        await this.exec('pg_advisory_unlock($1::bigint)', key);
      } catch (err) {
        // Still held: keep tracking it, so a retry or close() can unlock it.
        if (!(err instanceof Unavailable)) this.held.set(key, token);
        throw err;
      }
    });
    return Object.assign(release, {
      held: () => this.serial(async () => {
        if (!mine() || this.closed) return false;
        try {
          // Asking also refreshes the pid: a reconnect clears what was held.
          const ok = await this.exec(
            `exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted
                       and ((classid::bigint << 32) | objid::bigint) = $1::bigint)`, key);
          return ok && mine();
        } catch {
          return false;
        }
      }),
    });
  }

  /**
   * Unlocks every lock this client holds, after any call in flight; later
   * calls are refused. A lock whose unlock fails stays held until the caller
   * ends its session instance.
   */
  close(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      const keys = [...this.held.keys()];
      this.held.clear();
      for (const key of keys) await this.exec('pg_advisory_unlock($1::bigint)', key).catch(() => {});
    });
  }
}
