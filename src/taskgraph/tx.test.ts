import { describe, it, expect, onTestFinished } from 'vitest';
import { Kysely, PGliteDialect, sql } from 'kysely';
import type { PGlite } from '@electric-sql/pglite';
import { createMigratedTestDb, PGLITE_TIMEOUT, type TestDb } from './test/pglite';
import { runTransaction, MAX_RETRIES } from './tx';
import { ENGINE_VERSION } from './migrate';
import { Unavailable, NotFound, TaskGraphError } from './errors';
import { writeEvents } from './events';
import { LOCK_NAMESPACE } from './locks';

const P1 = '00000000-0000-0000-0000-000000000001';
const P2 = '00000000-0000-0000-0000-000000000002';
const noSleep = { sleep: async () => {} };

async function openDb(): Promise<TestDb> {
  const t = await createMigratedTestDb();
  onTestFinished(() => t.close());
  return t;
}

/** Raises a real Postgres error with the given SQLSTATE through the driver. */
function raise(tx: Kysely<any>, code: string) {
  return sql.raw(`do $$ begin raise exception 'injected' using errcode = '${code}'; end $$`).execute(tx);
}

async function count(t: TestDb, table: string): Promise<number> {
  return (await t.pglite.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;
}

describe('runTransaction', { timeout: PGLITE_TIMEOUT }, () => {
  it('runs at READ COMMITTED, with bounded timeouts and the writer version set', async () => {
    const t = await openDb();
    const settings = await runTransaction(t.db, async ({ db }) => {
      const r = await sql<Record<string, string>>`
        select current_setting('transaction_isolation') as iso,
               current_setting('lock_timeout') as lock,
               current_setting('statement_timeout') as stmt,
               current_setting('idle_in_transaction_session_timeout') as idle,
               current_setting('taskgraph.engine_version', true) as engine`.execute(db);
      return r.rows[0];
    });
    expect(settings).toEqual({ iso: 'read committed', lock: '5s', stmt: '30s', idle: '1min', engine: String(ENGINE_VERSION) });
  });

  it('reruns a transaction whose first two runs fail with a deadlock, and the third succeeds', async () => {
    const t = await openDb();
    let runs = 0;
    const result = await runTransaction(t.db, async ({ db }) => {
      runs++;
      await sql`insert into taskgraph.purges (project_id, name, actor, counts) values (${P1}, ${'run' + runs}, 'a', '{}')`.execute(db);
      if (runs <= 2) await raise(db, '40P01');
      return 'done';
    }, noSleep);
    expect(result).toBe('done');
    expect(runs).toBe(3);
    // the failed runs rolled back
    expect((await t.pglite.query(`select name from taskgraph.purges`)).rows).toEqual([{ name: 'run3' }]);
  });

  it('also reruns on a serialization failure', async () => {
    const t = await openDb();
    let runs = 0;
    await runTransaction(t.db, async ({ db }) => { if (++runs === 1) await raise(db, '40001'); }, noSleep);
    expect(runs).toBe(2);
  });

  it('waits a jittered, growing delay between runs', async () => {
    const t = await openDb();
    const waits: number[] = [];
    let runs = 0;
    await runTransaction(t.db, async ({ db }) => { if (++runs <= 3) await raise(db, '40P01'); }, {
      sleep: async ms => { waits.push(ms); },
      random: () => 0.5,
    });
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
  });

  it('gives up with Unavailable once its retries are used up', async () => {
    const t = await openDb();
    let runs = 0;
    const err = await runTransaction(t.db, async ({ db }) => { runs++; await raise(db, '40P01'); }, noSleep).catch(e => e);
    expect(runs).toBe(1 + MAX_RETRIES);
    expect(err).toBeInstanceOf(Unavailable);
    expect(err.code).toBe('Unavailable');
    expect(err.cause.code).toBe('40P01');
  });

  it('does not rerun other errors, and passes them through unchanged', async () => {
    const t = await openDb();
    let runs = 0;
    const typed = new NotFound('task', 'web-abc');
    await expect(runTransaction(t.db, async () => { runs++; throw typed; }, noSleep)).rejects.toBe(typed);
    expect(runs).toBe(1);

    runs = 0;
    const err = await runTransaction(t.db, async ({ db }) => { runs++; await raise(db, '23505'); }, noSleep).catch(e => e);
    expect(runs).toBe(1);
    expect(err).not.toBeInstanceOf(TaskGraphError);
    expect(err.code).toBe('23505');
  });

  it('maps a server-ended session to Unavailable, but passes a statement timeout through', async () => {
    const t = await openDb();
    for (const [code, typed] of [['25P03', true], ['57P05', true], ['53300', true], ['08006', true], ['57014', false], ['55P03', false]] as const) {
      const err = await runTransaction(t.db, async ({ db }) => { await raise(db, code); }, noSleep).catch(e => e);
      expect([code, err instanceof Unavailable]).toEqual([code, typed]);
    }
  });

  it('fails with Unavailable when the connection drops', async () => {
    const t = await openDb();
    let dropped = false;
    // postgres.js reports a lost connection as an Error with code CONNECTION_CLOSED.
    // Kysely's PGlite driver queries through the object transaction() hands it,
    // so that is wrapped too.
    const drop = <O extends object>(obj: O): O => new Proxy(obj, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') return v;
        if (prop === 'query' || prop === 'exec') {
          return (...args: unknown[]) => {
            if (dropped) throw Object.assign(new Error('write CONNECTION_CLOSED db:5432'), { code: 'CONNECTION_CLOSED' });
            return v.apply(target, args);
          };
        }
        if (prop === 'transaction') {
          return (cb: (tx: object) => unknown) => v.call(target, (tx: object) => cb(drop(tx)));
        }
        return v.bind(target);
      },
    });
    const flaky = drop(t.pglite) as PGlite;
    const db = new Kysely<any>({ dialect: new PGliteDialect({ pglite: flaky }) });
    let runs = 0;
    const err = await runTransaction(db, async ({ db: tx }) => {
      runs++;
      await sql`select 1`.execute(tx);
      dropped = true;
      await sql`select 1`.execute(tx);
    }, noSleep).catch(e => e);
    expect(err).toBeInstanceOf(Unavailable);
    expect(runs).toBe(1); // the outcome is unknown, so the caller retries with its request id
  });
});

describe('events', { timeout: PGLITE_TIMEOUT }, () => {
  it('are buffered and written last, in the order they were emitted', async () => {
    const t = await openDb();
    let seenDuringRun = -1;
    await runTransaction(t.db, async ({ db, emit }) => {
      emit({ projectId: P1, kind: 'task.created', actor: 'ann', actorRole: 'developer', taskId: 'web-a' });
      emit({ projectId: P1, kind: 'move:approve', actor: 'ann', actorRole: 'developer', taskId: 'web-a', fromState: 'proposed', toState: 'open', payload: { via: 'cli' }, requestId: 'r1' });
      seenDuringRun = (await sql<{ n: number }>`select count(*)::int as n from taskgraph.events`.execute(db)).rows[0].n;
    });
    expect(seenDuringRun).toBe(0);
    const rows = (await t.pglite.query(
      `select project_id, task_id, kind, actor, actor_role, from_state, to_state, payload, request_id from taskgraph.events order by id`,
    )).rows;
    expect(rows).toEqual([
      { project_id: P1, task_id: 'web-a', kind: 'task.created', actor: 'ann', actor_role: 'developer', from_state: null, to_state: null, payload: {}, request_id: null },
      { project_id: P1, task_id: 'web-a', kind: 'move:approve', actor: 'ann', actor_role: 'developer', from_state: 'proposed', to_state: 'open', payload: { via: 'cli' }, request_id: 'r1' },
    ]);
  });

  it('takes each project\'s events lock, held until commit', async () => {
    const t = await openDb();
    const locks = await t.db.transaction().execute(async tx => {
      await writeEvents(tx, [
        { projectId: P2, kind: 'note', actor: 'a', actorRole: 'developer' },
        { projectId: P1, kind: 'note', actor: 'a', actorRole: 'developer' },
      ]);
      return (await sql`
        select classid::text::bigint as ns, objid::text::bigint as key from pg_locks
         where locktype = 'advisory' and objsubid = 2 and pid = pg_backend_pid() order by 2`.execute(tx)).rows;
    });
    const expected = (await t.pglite.query<{ ns: string; key: string }>(
      `select ${LOCK_NAMESPACE.events}::bigint as ns, hashtext(p)::bigint & 4294967295 as key
         from unnest(array['${P1}', '${P2}']) p order by 2`,
    )).rows;
    expect(locks).toEqual(expected);
    expect(await count(t, 'taskgraph.events')).toBe(2);
  });

  it('writes a batch larger than one statement can bind, in order', async () => {
    const t = await openDb();
    const n = 6000;
    const ids = await runTransaction(t.db, async ({ db }) => writeEvents(db, Array.from({ length: n }, (_, i) => (
      { projectId: P1, kind: 'note', actor: 'a', actorRole: 'developer', payload: { i } }))));
    expect(ids).toHaveLength(n);
    const r = await t.pglite.query<{ ok: boolean }>(
      `select bool_and((payload->>'i')::int = rn - 1) as ok from (select payload, row_number() over (order by id) rn from taskgraph.events) e`,
    );
    expect(r.rows[0].ok).toBe(true);
  });

  it('are stamped with the database clock, taskgraph.now()', async () => {
    const t = await openDb();
    await runTransaction(t.db, async ({ db, emit }) => {
      await sql`set local taskgraph.fake_now = '2026-10-03T12:00:00Z'`.execute(db);
      emit({ projectId: P1, kind: 'note', actor: 'a', actorRole: 'developer' });
    });
    const r = await t.pglite.query<{ at: Date }>(`select at from taskgraph.events`);
    expect(r.rows[0].at.toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });

  it('keeps an original time when one is given', async () => {
    const t = await openDb();
    await runTransaction(t.db, async ({ emit }) => {
      emit({ projectId: P1, kind: 'note', actor: 'a', actorRole: 'developer', at: new Date('2025-01-02T03:04:05Z') });
    });
    const r = await t.pglite.query<{ at: Date }>(`select at from taskgraph.events`);
    expect(r.rows[0].at.toISOString()).toBe('2025-01-02T03:04:05.000Z');
  });

  it('from a failed run are dropped, so a rerun writes each event once', async () => {
    const t = await openDb();
    let runs = 0;
    await runTransaction(t.db, async ({ db, emit }) => {
      emit({ projectId: P1, kind: 'note', actor: 'a', actorRole: 'developer', payload: { run: ++runs } });
      if (runs === 1) await raise(db, '40P01');
    }, noSleep);
    expect((await t.pglite.query(`select payload from taskgraph.events`)).rows).toEqual([{ payload: { run: 2 } }]);
  });

  it('are not written when the transaction fails', async () => {
    const t = await openDb();
    await expect(runTransaction(t.db, async ({ emit }) => {
      emit({ projectId: P1, kind: 'note', actor: 'a', actorRole: 'developer' });
      throw new Error('nope');
    })).rejects.toThrow('nope');
    expect(await count(t, 'taskgraph.events')).toBe(0);
  });
});
