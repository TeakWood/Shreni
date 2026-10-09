import { sql, type Kysely, type Transaction } from 'kysely';
import { ENGINE_VERSION, WRITER_VERSION_SETTING } from './migrate';
import { writeEvents, type NewEvent } from './events';
import { InvalidRequest, TaskGraphError, Unavailable, VersionMismatch } from './errors';

// The transaction runner (engine spec, "Claiming and leases: Transactions").
// Every engine transaction runs at READ COMMITTED with bounded timeouts, marks
// its writes with this process's engine version, writes its events last, and is
// rerun whole on a serialization failure or deadlock.

/** Reruns after the first run, on a serialization failure or deadlock. */
export const MAX_RETRIES = 3;

export interface EngineTx {
  db: Transaction<any>;
  /** Buffers an event; the runner writes them all after `fn` returns. */
  emit(event: NewEvent): void;
}

export interface TransactionOptions {
  /** Waits between runs; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The jitter source, in [0, 1). */
  random?: () => number;
  /** The lifecycle this process runs; the trigger refuses a write to a project on another version. */
  lifecycle?: { name: string; version: number };
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

// Codes for a connection that is gone or never came: postgres.js's own, Node's
// socket errors, Postgres's connection-exception class (08…), shutdowns, the
// server ending an idle session, and no free connection slot.
const CONNECTION_CODES = new Set([
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  '57P01', '57P02', '57P03', '57P05', '25P03', '53300',
]);

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Runs `fn` in one engine transaction. The whole transaction, `fn` included, is
 * rerun on a serialization failure or deadlock, so `fn` must do nothing outside
 * the database. Errors `fn` throws pass through unchanged, as do Postgres
 * errors such as a lock or statement timeout; a lost connection, or retries
 * used up, surface as Unavailable.
 */
export async function runTransaction<T>(
  db: Kysely<any>,
  fn: (tx: EngineTx) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  for (let retry = 0; ; retry++) {
    try {
      return await db.transaction().setIsolationLevel('read committed').execute(async trx => {
        await sql`select
          set_config('lock_timeout', '5s', true),
          set_config('statement_timeout', '30s', true),
          set_config('idle_in_transaction_session_timeout', '60s', true),
          set_config(${WRITER_VERSION_SETTING}, ${String(ENGINE_VERSION)}, true),
          set_config('taskgraph.lifecycle_name', ${opts.lifecycle?.name ?? ''}, true),
          set_config('taskgraph.lifecycle_version', ${String(opts.lifecycle?.version ?? '')}, true)`.execute(trx);
        const events: NewEvent[] = [];
        let flushed = false;
        const result = await fn({
          db: trx,
          emit(event) {
            if (flushed) throw new Error('taskgraph: event emitted after the transaction wrote its events');
            events.push(event);
          },
        });
        flushed = true;
        await writeEvents(trx, events);
        return result;
      });
    } catch (err) {
      if (err instanceof TaskGraphError) throw err;
      const code = errorCode(err);
      // Raised by the backstop trigger (migrations/0002_triggers.ts).
      if (code === 'TG001') throw new VersionMismatch((err as Error).message);
      if (code === 'TG002') throw new InvalidRequest((err as Error).message);
      if (RETRYABLE.has(code)) {
        if (retry >= MAX_RETRIES) throw new Unavailable(`transaction gave up after ${MAX_RETRIES} retries`, err);
        // exponential backoff with jitter: about 20, 40, 80 ms
        await sleep(Math.round(20 * 2 ** retry * (0.5 + random())));
        continue;
      }
      if (CONNECTION_CODES.has(code) || code.startsWith('08')) throw new Unavailable('database connection failed', err);
      throw err;
    }
  }
}
