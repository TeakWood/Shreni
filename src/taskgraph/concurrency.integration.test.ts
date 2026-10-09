import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { openProcesses, openProcess } from './test/postgres';
import { testLifecycle } from './test/lifecycle';
import { CycleError, LeaseLost, MoveRefused, VersionMismatch } from './errors';
import type { Claim } from './claims';

// The engine spec's concurrency scenarios (Testing), on real Postgres: each
// "process" has its own connections, so locks, SKIP LOCKED and commit order
// are exercised for real.

const LEASE = 60_000;
const settled = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);

describe('concurrency on real Postgres', () => {
  it('8 workers drain 200 tasks with random dependencies: each finishes once, none before its dependencies', async () => {
    const { procs, tg } = await openProcesses(8);
    const sys = tg(0).as({ id: 'sys', role: 'system' });
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push((await sys.tasks.create({ title: `t${i}`, priority: i % 5 })).id);
    // dependencies only on earlier tasks, so the graph stays acyclic
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const dev = tg(0).as({ id: 'dev', role: 'developer' });
    for (let i = 1; i < 200; i++) {
      for (let k = 0; k < 2; k++) if (rand(3) === 0) await dev.deps.add(ids[i], ids[rand(i)]);
    }

    const violations: string[] = [];
    const worker = async (w: number) => {
      const as = tg(w).as({ id: `orc${w}`, role: 'orchestrator' });
      const db = procs[w].sql;
      for (;;) {
        const c = await as.claim({ worker: `w${w}`, leaseMs: LEASE });
        if (!c) {
          const [{ left }] = await db`select count(*)::int as left from taskgraph.tasks where state <> 'done'`;
          if (left === 0) return;
          await new Promise(r => setTimeout(r, 20));
          continue;
        }
        const [{ unmet }] = await db`
          select count(*)::int as unmet from taskgraph.task_deps d join taskgraph.tasks t on t.id = d.depends_on_id
           where d.task_id = ${c.task.id} and t.state <> 'done'`;
        if (unmet > 0) violations.push(c.task.id);
        await as.moveClaimed(c, 'finish');
      }
    };
    await Promise.all(procs.map((_, w) => worker(w)));

    expect(violations).toEqual([]);
    const rows = await procs[0].sql`
      select t.state, (select count(*)::int from taskgraph.attempts a where a.task_id = t.id and a.outcome = 'finish') as finishes
        from taskgraph.tasks t`;
    expect(rows.length).toBe(200);
    expect(rows.every(r => r.state === 'done' && r.finishes === 1)).toBe(true);
  });

  it('a worker killed mid-attempt: its lease expires, another finishes the task, and its late finish gets LeaseLost', async () => {
    const { procs, tg } = await openProcesses(2);
    const t = await tg(0).as({ id: 'sys', role: 'system' }).tasks.create({ title: 't' });
    const a = tg(0).as({ id: 'a', role: 'orchestrator' });
    const b = tg(1).as({ id: 'b', role: 'orchestrator' });
    const dead = (await a.claim({ worker: 'a', leaseMs: 300 }))!;
    await new Promise(r => setTimeout(r, 500)); // a stops heartbeating
    const live = (await b.claim({ worker: 'b', leaseMs: LEASE }))!;
    expect(live.task.id).toBe(t.id);
    await b.moveClaimed(live, 'finish');
    await expect(a.moveClaimed(dead, 'finish')).rejects.toBeInstanceOf(LeaseLost);
    expect((await procs[0].sql`select outcome from taskgraph.attempts order by started_at`).map(r => r.outcome)).toEqual(['expire', 'finish']);
  });

  it('two connections add edges that would together form a cycle: exactly one succeeds', async () => {
    const { tg } = await openProcesses(2);
    const sys = tg(0).as({ id: 'sys', role: 'system' });
    for (let round = 0; round < 10; round++) {
      const x = await sys.tasks.create({ title: 'x' });
      const y = await sys.tasks.create({ title: 'y' });
      const results = await settled([
        tg(0).as({ id: 'd0', role: 'developer' }).deps.add(x.id, y.id),
        tg(1).as({ id: 'd1', role: 'developer' }).deps.add(y.id, x.id),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(CycleError);
    }
  });

  it('two workers finish a container\'s last two children at once: exactly one children.settled', async () => {
    const { procs, tg } = await openProcesses(2);
    for (let round = 0; round < 10; round++) {
      const sys = tg(0).as({ id: 'sys', role: 'system' });
      const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
      await sys.tasks.create({ title: 'a', parent: epic.id });
      await sys.tasks.create({ title: 'b', parent: epic.id });
      const claims: Claim[] = [];
      for (const w of [0, 1]) claims.push((await tg(w).as({ id: `o${w}`, role: 'orchestrator' }).claim({ worker: `w${w}`, leaseMs: LEASE, filter: { within: epic.id } }))!);
      await Promise.all([0, 1].map(w => tg(w).as({ id: `o${w}`, role: 'orchestrator' }).moveClaimed(claims[w], 'finish')));
      const [{ n }] = await procs[0].sql`select count(*)::int as n from taskgraph.events where kind = 'children.settled' and task_id = ${epic.id}`;
      expect(n).toBe(1);
    }
  });

  it('a claim repeated with the same request id after the connection dropped gets the same attempt, and no second task', async () => {
    const { url, procs, projectId, tg } = await openProcesses(1);
    const sys = tg(0).as({ id: 'sys', role: 'system' });
    await sys.tasks.create({ title: 'a' });
    await sys.tasks.create({ title: 'b' });
    const first = (await tg(0).as({ id: 'w', role: 'orchestrator' }).claim({ worker: 'w', leaseMs: LEASE, requestId: 'r1' }))!;
    // the reply was lost with the connection: the worker reconnects and retries
    await procs[0].end();
    const again = await openProcess(url);
    const second = await again.client.project(projectId).as({ id: 'w', role: 'orchestrator' })
      .claim({ worker: 'w', leaseMs: LEASE, requestId: 'r1' });
    expect(second!.attemptId).toBe(first.attemptId);
    const [{ n }] = await again.sql`select count(*)::int as n from taskgraph.attempts`;
    expect(n).toBe(1);
  });

  it('two connections send one claim\'s request id at once: both get the same attempt', async () => {
    const { procs, tg } = await openProcesses(2);
    const sys = tg(0).as({ id: 'sys', role: 'system' });
    await sys.tasks.create({ title: 'a' });
    await sys.tasks.create({ title: 'b' });
    const [c0, c1] = await Promise.all([0, 1].map(w =>
      tg(w).as({ id: 'w', role: 'orchestrator' }).claim({ worker: 'w', leaseMs: LEASE, requestId: 'same' })));
    expect(c0!.attemptId).toBe(c1!.attemptId);
    const [{ n }] = await procs[0].sql`select count(*)::int as n from taskgraph.attempts`;
    expect(n).toBe(1);
  });

  it('readers following events.since while writers commit out of order miss nothing', async () => {
    const { procs, tg } = await openProcesses(6);
    const writers = [0, 1, 2, 3].map(w => (async () => {
      const as = tg(w).as({ id: `s${w}`, role: 'system' });
      for (let i = 0; i < 40; i++) await as.tasks.create({ title: `w${w}-${i}` });
    })());
    const seen: string[][] = [[], []];
    let writing = true;
    const readers = [4, 5].map((p, r) => (async () => {
      let cursor = '0';
      const drain = async () => {
        for (;;) {
          const page = await tg(p).events.since(cursor, 50);
          for (const e of page) seen[r].push(e.id);
          if (!page.length) return;
          cursor = page[page.length - 1].id;
        }
      };
      while (writing) {
        await drain();
        await new Promise(res => setTimeout(res, 5));
      }
      // Every writer has committed: a drain started now sees all of it.
      await drain();
    })());
    await Promise.all(writers);
    writing = false;
    await Promise.all(readers);
    const all = (await procs[0].sql`select e.id::text as id from taskgraph.events e order by e.id`).map(r => r.id);
    for (const ids of seen) expect(ids).toEqual(all);
  });
});

describe('races the reviews asked for', () => {
  it('a purge racing writers leaves no event of the project behind, and no foreign-key error escapes', async () => {
    const { procs, projectId, tg } = await openProcesses(3);
    const sys = tg(0).as({ id: 'sys', role: 'system' });
    const tasks = [];
    for (let i = 0; i < 10; i++) tasks.push(await sys.tasks.create({ title: `t${i}` }));
    let written = 0;
    const writes = [1, 2].map(w => (async () => {
      const as = tg(w).as({ id: `d${w}`, role: 'developer' });
      const errors: unknown[] = [];
      for (let i = 0; i < 200; i++) {
        await as.notes.add(tasks[i % 10].id, `n${i}`).then(() => { written++; }, e => errors.push(e));
      }
      return errors;
    })());
    // purge once the writers are mid-stream, so it overlaps their writes
    while (written < 20) await new Promise(r => setTimeout(r, 2));
    await procs[0].client.projects.purge(projectId, { actor: { id: 'admin', role: 'developer' }, confirmName: 'web' });
    const errors = (await Promise.all(writes)).flat();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(e => (e as { code?: string }).code === 'NotFound')).toBe(true);
    const [{ n }] = await procs[0].sql`select count(*)::int as n from taskgraph.events where project_id = ${projectId}`;
    expect(n).toBe(0);
  });

  it('old-version writes racing activation commit before it or get VersionMismatch; no task lands in a state the new version lacks', async () => {
    const { url, procs, projectId, tg } = await openProcesses(2);
    const v2 = testLifecycle();
    v2.version = 2;
    delete v2.states.parked;
    v2.moves = v2.moves.filter(m => m.name !== 'park' && m.name !== 'unpark')
      .map(m => (m.name === 'cancel' ? { ...m, from: m.from.filter(s => s !== 'parked') } : m));
    v2.permissions['tasks.update'] = { developer: ['proposed', 'open', 'blocked'], planner: ['proposed'] };
    v2.migrate = { parked: 'blocked' };
    const next = await openProcess(url, v2);
    const old = [1, 1, 1].map(() => openProcess(url));
    const writers = await Promise.all(old);
    let ok = 0;
    const writes = writers.map((w, i) => (async () => {
      const as = w.client.project(projectId).as({ id: `old${i}`, role: 'developer' });
      const out: unknown[] = [];
      for (let k = 0; k < 40; k++) {
        await as.tasks.create({ title: `c${i}-${k}` }).then(t => as.move(t.id, 'park')).then(() => { ok++; }, e => out.push(e));
      }
      return out;
    })());
    // activate once the old writers are mid-stream
    while (ok < 10) await new Promise(r => setTimeout(r, 2));
    await next.client.project(projectId).as({ id: 'd', role: 'developer' }).lifecycles.activate(2);
    const errors = (await Promise.all(writes)).flat();
    expect(ok).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(e => e instanceof VersionMismatch)).toBe(true);
    const [{ n }] = await procs[0].sql`select count(*)::int as n from taskgraph.tasks where state = 'parked'`;
    expect(n).toBe(0);
  });

  it('a discard racing a child created under its plan container never leaves a live child under a cancelled container', async () => {
    const { procs, tg } = await openProcesses(2);
    for (let round = 0; round < 10; round++) {
      const p = await tg(0).as({ id: 'pl', role: 'planner' }).plans.create({ title: 'p' });
      const epic = await tg(0).as({ id: 'pl', role: 'planner' }).tasks.create({ title: 'epic', kind: 'container', plan: p.id });
      await settled([
        tg(0).as({ id: 'd', role: 'developer' }).plans.discard(p.id, { via: 'test' }),
        tg(1).as({ id: 's', role: 'system' }).tasks.create({ title: 'late', parent: epic.id }),
      ]);
      const [{ n }] = await procs[0].sql`
        select count(*)::int as n from taskgraph.tasks c join taskgraph.tasks p on p.id = c.parent_id
         where p.state = 'cancelled' and c.state not in ('done', 'cancelled')`;
      expect(n).toBe(0);
    }
  });

  it('a discard racing a sibling\'s finish writes exactly one children.settled', async () => {
    const { procs, tg } = await openProcesses(2);
    for (let round = 0; round < 10; round++) {
      const sys = tg(0).as({ id: 's', role: 'system' });
      const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
      const p = await tg(0).as({ id: 'pl', role: 'planner' }).plans.create({ title: 'p' });
      await tg(0).as({ id: 'pl', role: 'planner' }).tasks.create({ title: 'in plan', plan: p.id, parent: epic.id });
      await sys.tasks.create({ title: 'outside', parent: epic.id });
      const c = (await tg(1).as({ id: 'o', role: 'orchestrator' }).claim({ worker: 'w', leaseMs: LEASE, filter: { within: epic.id } }))!;
      await Promise.all([
        tg(0).as({ id: 'd', role: 'developer' }).plans.discard(p.id, { via: 'test' }),
        tg(1).as({ id: 'o', role: 'orchestrator' }).moveClaimed(c, 'finish'),
      ]);
      const [{ n }] = await procs[0].sql`select count(*)::int as n from taskgraph.events where kind = 'children.settled' and task_id = ${epic.id}`;
      expect(n).toBe(1);
    }
  });

  it('postgres.js reports a request-id clash by constraint_name', async () => {
    const { procs, projectId } = await openProcesses(1);
    const db = procs[0].sql;
    await db`insert into taskgraph.events (project_id, kind, actor, actor_role, request_id) values (${projectId}, 'x', 'a', 'r', 'dup')`;
    const err = await db`insert into taskgraph.events (project_id, kind, actor, actor_role, request_id) values (${projectId}, 'x', 'a', 'r', 'dup')`
      .catch(e => e as postgres.PostgresError);
    expect(err).toMatchObject({ code: '23505', constraint_name: 'events_request' });
  });

  it('a move refused under contention is MoveRefused, never a raw error', async () => {
    const { tg } = await openProcesses(2);
    const t = await tg(0).as({ id: 's', role: 'system' }).tasks.create({ title: 't' });
    const results = await settled([0, 1].map(w => tg(w).as({ id: `d${w}`, role: 'developer' }).move(t.id, 'park')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(MoveRefused);
  });
});
