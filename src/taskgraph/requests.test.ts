import { describe, it, expect } from 'vitest';
import { openEngine } from './test/engine';
import { InvalidRequest, LeaseLost, MoveRefused } from './errors';
import { once } from './requests';

// Idempotent retries (engine spec, "Claiming and leases", Idempotent retries):
// a write repeated with a used request id returns the first result instead of
// acting again; a refused write stores nothing, so its retry is judged afresh.

const HOUR = 3_600_000;

describe('request ids', { timeout: 30_000 }, () => {
  it('a claim retried with the same request id gets the same attempt back, and no second task is leased', async () => {
    const e = await openEngine();
    await e.as('system').tasks.create({ title: 'a' });
    await e.as('system').tasks.create({ title: 'b' });
    const orc = e.as('orchestrator');
    const first = await orc.claim({ worker: 'w', leaseMs: HOUR, requestId: 'claim-1' });
    const again = await orc.claim({ worker: 'w', leaseMs: HOUR, requestId: 'claim-1' });
    expect(again).toEqual(first);
    expect(await e.rows(`select count(*)::int n from taskgraph.attempts`)).toEqual([{ n: 1 }]);
    expect(await e.rows(`select count(*)::int n from taskgraph.tasks where state = 'claimed'`)).toEqual([{ n: 1 }]);

    // once the attempt has ended, the retry gets LeaseLost, never a second task
    await orc.move(first!.task.id, 'release');
    await expect(orc.claim({ worker: 'w', leaseMs: HOUR, requestId: 'claim-1' })).rejects.toBeInstanceOf(LeaseLost);
  });

  it('a nothing-to-claim result stores nothing, so the retry is judged afresh', async () => {
    const e = await openEngine();
    const orc = e.as('orchestrator');
    expect(await orc.claim({ worker: 'w', leaseMs: HOUR, requestId: 'c' })).toBeNull();
    await e.as('system').tasks.create({ title: 'a' });
    expect(await orc.claim({ worker: 'w', leaseMs: HOUR, requestId: 'c' })).not.toBeNull();
  });

  it('create, update, move, note, dependency and link writes return their first result on a retry', async () => {
    const e = await openEngine();
    const dev = e.as('developer');
    const t = await dev.tasks.create({ title: 't' }, { requestId: 'r-create' });
    expect(await dev.tasks.create({ title: 't' }, { requestId: 'r-create' })).toEqual(t);
    expect(await e.tg.tasks.count()).toBe(1);

    const u = await dev.tasks.update(t.id, { title: 'u' }, { requestId: 'r-update' });
    expect(await dev.tasks.update(t.id, { title: 'u' }, { requestId: 'r-update' })).toEqual(u);

    const moved = await dev.move(t.id, 'approve', { requestId: 'r-move' });
    // a second approve would be WrongState; the retry returns the first result instead
    expect(await dev.move(t.id, 'approve', { requestId: 'r-move' })).toEqual(moved);

    await dev.notes.add(t.id, 'hi', { requestId: 'r-note' });
    await dev.notes.add(t.id, 'hi', { requestId: 'r-note' });
    expect(await e.rows(`select count(*)::int n from taskgraph.events where kind = 'note'`)).toEqual([{ n: 1 }]);

    const other = await e.as('system').tasks.create({ title: 'o' });
    await dev.deps.add(t.id, other.id, { requestId: 'r-dep' });
    await dev.deps.remove(t.id, other.id);
    await dev.deps.add(t.id, other.id, { requestId: 'r-dep' });
    expect(await e.rows(`select count(*)::int n from taskgraph.task_deps`)).toEqual([{ n: 0 }]);
    await dev.links.add(t.id, other.id, 'related', { requestId: 'r-link' });
    await dev.links.add(t.id, other.id, 'related', { requestId: 'r-link' });
    expect(await e.rows(`select count(*)::int n from taskgraph.events where kind = 'link.added'`)).toEqual([{ n: 1 }]);
  });

  it('a refused write stores nothing, so its retry is judged afresh', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    const err = await e.as('developer').move(t.id, 'unpark', { requestId: 'r' }).catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    await e.as('developer').move(t.id, 'park');
    expect(await e.as('developer').move(t.id, 'unpark', { requestId: 'r' })).toMatchObject({ state: 'open' });
  });

  it('refuses a request id already used by a different write', async () => {
    const e = await openEngine();
    const t = await e.as('developer').tasks.create({ title: 't' }, { requestId: 'r' });
    await expect(e.as('developer').notes.add(t.id, 'x', { requestId: 'r' })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.as('developer').move(t.id, 'cancel', { requestId: 'r' })).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('a moveClaimed retried after it ended the attempt returns its first result', async () => {
    const e = await openEngine();
    await e.as('system').tasks.create({ title: 't' });
    const orc = e.as('orchestrator');
    const c = (await orc.claim({ worker: 'w', leaseMs: HOUR }))!;
    const done = await orc.moveClaimed(c, 'submit', { requestId: 'r-submit' });
    expect(await orc.moveClaimed(c, 'submit', { requestId: 'r-submit' })).toEqual(done);
  });
});

describe('a concurrent duplicate', { timeout: 30_000 }, () => {
  it('loses at the unique index, rolls back, and returns the winner\'s result', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    // the winner's event commits while this write is in flight
    const r = await once(e.t.db, e.tg.id, 'dup', 'note', { actor: 'other', taskId: t.id }, async () => {
      await e.t.pglite.query(`insert into taskgraph.events (project_id, task_id, kind, actor, actor_role, request_id)
                              values ($1, $2, 'note', 'other', 'developer', 'dup')`, [e.tg.id, t.id]);
      await e.t.pglite.query(`insert into taskgraph.events (project_id, task_id, kind, actor, actor_role, request_id)
                              values ($1, $2, 'note', 'me', 'developer', 'dup')`, [e.tg.id, t.id]);
      return 'acted';
    }, async p => `replayed ${p.taskId}`);
    expect(r).toBe(`replayed ${t.id}`);
  });
});

describe('review follow-ups (T2.3)', { timeout: 30_000 }, () => {
  it('replays only to the same actor on the same task; a reused id elsewhere is refused', async () => {
    const e = await openEngine();
    const dev = e.as('developer');
    const t1 = await dev.tasks.create({ title: 'a' });
    const t2 = await dev.tasks.create({ title: 'b' });
    await dev.tasks.update(t1.id, { title: 'a2' }, { requestId: 'r' });
    await expect(dev.tasks.update(t2.id, { title: 'x' }, { requestId: 'r' })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.tg.as({ id: 'other', role: 'developer' }).tasks.update(t1.id, { title: 'a2' }, { requestId: 'r' }))
      .rejects.toBeInstanceOf(InvalidRequest);

    await e.as('system').tasks.create({ title: 'ready' });
    await e.tg.as({ id: 'A', role: 'orchestrator' }).claim({ worker: 'a', leaseMs: HOUR, requestId: 'claim-1' });
    await expect(e.tg.as({ id: 'B', role: 'orchestrator' }).claim({ worker: 'b', leaseMs: HOUR, requestId: 'claim-1' }))
      .rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.as('planner').claim({ worker: 'p', leaseMs: HOUR, requestId: 'claim-1' })).rejects.toThrow(/may not/);
  });

  it('replays when the write fails after the first one with its id committed, whatever the error', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    const r = await once(e.t.db, e.tg.id, 'dup', 'move:approve', { actor: 'me', taskId: t.id }, async () => {
      await e.t.pglite.query(`insert into taskgraph.events (project_id, task_id, kind, actor, actor_role, request_id)
                              values ($1, $2, 'move:approve', 'me', 'developer', 'dup')`, [e.tg.id, t.id]);
      throw new MoveRefused(t.id, 'open', 'WrongState');
    }, async p => `replayed ${p.taskId}`);
    expect(r).toBe(`replayed ${t.id}`);
  });

  it('lifecycles.activate takes a request id', async () => {
    const e = await openEngine();
    const lc = (await import('./test/lifecycle')).testLifecycle();
    lc.version = 2;
    const { openTaskGraph } = await import('./client');
    const next = await openTaskGraph({ db: e.t.db, lifecycle: lc });
    const as = next.project(e.tg.id).as({ id: 'd', role: 'developer' });
    await as.lifecycles.activate(2, { requestId: 'up' });
    await as.lifecycles.activate(2, { requestId: 'up' });
  });
});
