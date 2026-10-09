import { describe, it, expect, onTestFinished } from 'vitest';
import postgres from 'postgres';
import { openEngine } from './test/engine';
import { createWireTestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph } from './client';
import { InvalidRequest } from './errors';

// Session locks (engine spec, "Connections" and the API's tg.locks.trySession):
// a session advisory lock on the client's one session connection, held until
// released or until that connection closes.

const COUNT = `select count(*)::int n from pg_locks where locktype = 'advisory'`;
const ann = { id: 'a', role: 'developer' };

describe('tg.locks.trySession', { timeout: 30_000 }, () => {
  it('takes a named lock and releases it; held() follows it, and a second release does nothing', async () => {
    const e = await openEngine();
    const release = (await e.tg.locks.trySession('worker'))!;
    expect(await release.held()).toBe(true);
    expect(await e.rows(COUNT)).toEqual([{ n: 1 }]);
    await release();
    await release();
    expect(await release.held()).toBe(false);
    expect(await e.rows(COUNT)).toEqual([{ n: 0 }]);
    await expect(e.tg.locks.trySession('')).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('excludes within the process too: the same name twice gets null', async () => {
    const e = await openEngine();
    expect(await e.tg.locks.trySession('worker')).toBeTypeOf('function');
    expect(await e.tg.locks.trySession('worker')).toBeNull();
    expect(await e.tg.locks.trySession('sweeper')).toBeTypeOf('function');
  });

  it('closing releases exactly this client\'s locks, and refuses later calls', async () => {
    const e = await openEngine();
    const other = await openTaskGraph({ db: e.t.db, lifecycle: testLifecycle() });
    const mine = await e.tg.locks.trySession('worker');
    const theirs = await other.project(e.tg.id).locks.trySession('sweeper');
    expect(await e.rows(COUNT)).toEqual([{ n: 2 }]);
    await e.client.close();
    expect(await e.rows(COUNT)).toEqual([{ n: 1 }]);
    expect(await theirs!.held()).toBe(true);
    await expect(e.tg.locks.trySession('worker')).rejects.toBeInstanceOf(InvalidRequest);
    await mine!(); // after close: nothing to do
    await other.close();
  });

  it('on postgres.js, runs on the caller\'s session instance, which must be one connection with no max_lifetime', async () => {
    // two server connections: the pool's, and the session's
    const w = await createWireTestDb(2);
    onTestFinished(() => w.close());
    const plain = await openTaskGraph({ sql: w.sql, lifecycle: testLifecycle() });
    await plain.migrate();
    const p = await plain.projects.create({ name: 'web', idPrefix: 'web', actor: ann });
    await expect(plain.project(p.id).locks.trySession('worker')).rejects.toThrow(/session instance/);
    await plain.close();

    await expect(openTaskGraph({ sql: w.sql, session: w.connect({ max: 2 }), lifecycle: testLifecycle() })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(openTaskGraph({ sql: w.sql, session: w.connect({ max: 1 }), lifecycle: testLifecycle() })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(openTaskGraph({ sql: w.sql, session: w.connect({ max: 1, max_lifetime: null, idle_timeout: 20 }), lifecycle: testLifecycle() }))
      .rejects.toBeInstanceOf(InvalidRequest);

    const session = w.connect({ max: 1, max_lifetime: null });
    const client = await openTaskGraph({ sql: w.sql, session, lifecycle: testLifecycle() });
    const release = (await client.project(p.id).locks.trySession('worker'))!;
    expect(await release.held()).toBe(true);
    expect((await w.sql`select count(*)::int n from pg_locks where locktype = 'advisory'`)[0].n).toBe(1);
    await client.close();
    expect((await w.sql`select count(*)::int n from pg_locks where locktype = 'advisory'`)[0].n).toBe(0);
    expect(await release.held()).toBe(false);
    // the session instance is the caller's: still open after close
    expect((await session`select 1 as one`)[0].one).toBe(1);
  });

  it('a stale release never unlocks a later acquisition of the same name', async () => {
    const e = await openEngine();
    const r1 = (await e.tg.locks.trySession('worker'))!;
    await r1();
    const r2 = (await e.tg.locks.trySession('worker'))!;
    await r1();
    expect(await r1.held()).toBe(false);
    expect(await r2.held()).toBe(true);
    expect(await e.rows(COUNT)).toEqual([{ n: 1 }]);
  });

  it('concurrent tries for one name: exactly one gets it, and its release leaves nothing held', async () => {
    const e = await openEngine();
    const results = await Promise.all([e.tg.locks.trySession('worker'), e.tg.locks.trySession('worker')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await results.find(Boolean)!();
    expect(await e.rows(COUNT)).toEqual([{ n: 0 }]);
  });
});

// Two processes need two real sessions, which PGlite can't give; this runs
// against any Postgres named by TASKGRAPH_TEST_DATABASE_URL, and in the
// concurrency tier.
const url = process.env.TASKGRAPH_TEST_DATABASE_URL;
describe.skipIf(!url)('session locks across processes (real Postgres)', { timeout: 60_000 }, () => {
  it('B gets nothing while A holds the worker lock, and gets it once A\'s connection is gone; A learns it lost it', async () => {
    const sqlA = postgres(url!, { max: 2, onnotice: () => {} });
    const sqlB = postgres(url!, { max: 2, onnotice: () => {} });
    const sessionA = postgres(url!, { max: 1, max_lifetime: null, onnotice: () => {} });
    const sessionB = postgres(url!, { max: 1, max_lifetime: null, onnotice: () => {} });
    onTestFinished(async () => {
      for (const s of [sqlA, sqlB, sessionA, sessionB]) await s.end({ timeout: 1 });
    });
    const a = await openTaskGraph({ sql: sqlA, session: sessionA, lifecycle: testLifecycle() });
    await a.migrate();
    const b = await openTaskGraph({ sql: sqlB, session: sessionB, lifecycle: testLifecycle() });
    const p = await a.projects.create({ name: 'locks', idPrefix: 'lk', actor: ann });

    const held = (await a.project(p.id).locks.trySession('worker'))!;
    expect(await b.project(p.id).locks.trySession('worker')).toBeNull();

    // A's session connection dies without A closing anything, as when its process crashes
    const [{ pid }] = await sessionA`select pg_backend_pid() as pid`;
    await sqlB`select pg_terminate_backend(${pid})`;
    // termination is a signal: B gets the lock once A's backend has gone
    let got = null;
    for (let i = 0; i < 50 && !got; i++) {
      got = await b.project(p.id).locks.trySession('worker');
      if (!got) await new Promise(r => setTimeout(r, 100));
    }
    expect(got).toBeTypeOf('function');

    // A finds the lock gone: its session reconnected to a new backend
    let lost = false;
    for (let i = 0; i < 3 && !lost; i++) lost = !(await held.held().catch(() => false));
    expect(lost).toBe(true);
    expect(await a.project(p.id).locks.trySession('other')).toBeTypeOf('function'); // the new session works
    await got!();
    await a.close();
    await b.close();
  });
});
