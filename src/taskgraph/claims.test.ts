import { describe, it, expect } from 'vitest';
import { openEngine, type TestEngine } from './test/engine';
import { testLifecycle } from './test/lifecycle';
import { lifecycleViolations } from './lifecycle';
import { InvalidRequest, LeaseHeld, LeaseLost, NotFound, NotPermitted } from './errors';

// Claims and the lease sweep (engine spec, "Claiming and leases").

const T0 = new Date('2026-10-09T12:00:00Z');
const HOUR = 3_600_000;

/** Sets the database clock that taskgraph.now() reads. */
async function clock(e: TestEngine, at: Date) {
  await e.t.pglite.query(`select set_config('taskgraph.fake_now', $1, false)`, [at.toISOString()]);
}

const orc = (e: TestEngine) => e.as('orchestrator');
const claim = (e: TestEngine, worker = 'w/1', leaseMs = HOUR) => orc(e).claim({ worker, leaseMs });

describe('claim', { timeout: 30_000 }, () => {
  it('leases the next ready task in claim order, with an attempt, a lease and a claim event', async () => {
    const e = await openEngine();
    await clock(e, T0);
    const sys = e.as('system');
    await sys.tasks.create({ title: 'low', priority: 3 });
    const high = await sys.tasks.create({ title: 'high', priority: 1 });
    await e.as('planner').tasks.create({ title: 'unapproved', priority: 0 });

    const c = await claim(e);
    expect(c).toMatchObject({ task: { id: high.id, state: 'claimed' }, expiresAt: new Date(T0.getTime() + HOUR) });
    expect(c!.task.leaseAttemptId).toBe(c!.attemptId);
    expect(await e.rows(`select task_id, worker, actor, ended_at from taskgraph.attempts`))
      .toEqual([{ task_id: high.id, worker: 'w/1', actor: 'orchestrator', ended_at: null }]);
    expect(await e.rows(`select kind, task_id, attempt_id, from_state, to_state, payload from taskgraph.events where kind like 'move:%'`))
      .toEqual([{ kind: 'move:claim', task_id: high.id, attempt_id: c!.attemptId, from_state: 'open', to_state: 'claimed',
        payload: { worker: 'w/1', leaseMs: HOUR } }]);
    expect((await e.tg.tasks.get(high.id)).claim).toMatchObject({ attemptId: c!.attemptId, worker: 'w/1', expired: false });
  });

  it('returns null when nothing is ready, and takes a filter such as within', async () => {
    const e = await openEngine();
    expect(await claim(e)).toBeNull();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    await sys.tasks.create({ title: 'loose', priority: 0 });
    const inside = await sys.tasks.create({ title: 'inside', parent: epic.id, priority: 4 });
    expect((await orc(e).claim({ worker: 'w', leaseMs: HOUR, filter: { within: epic.id } }))!.task.id).toBe(inside.id);
    expect(await orc(e).claim({ worker: 'w', leaseMs: HOUR, filter: { within: epic.id } })).toBeNull();
  });

  it('is refused for a role the claim move doesn\'t list, and for a bad lease length or worker', async () => {
    const e = await openEngine();
    await e.as('system').tasks.create({ title: 't' });
    await expect(e.as('planner').claim({ worker: 'w', leaseMs: HOUR })).rejects.toBeInstanceOf(NotPermitted);
    await expect(orc(e).claim({ worker: 'w', leaseMs: 0 })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(orc(e).claim({ worker: 'w', leaseMs: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(orc(e).claim({ worker: '', leaseMs: HOUR })).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('runs the sweep first, so a lapsed lease is claimable again in the same call', async () => {
    const e = await openEngine();
    await clock(e, T0);
    const t = await e.as('system').tasks.create({ title: 't' });
    const first = await claim(e, 'w/1');
    await clock(e, new Date(T0.getTime() + 2 * HOUR));
    const second = await claim(e, 'w/2');
    expect(second).toMatchObject({ task: { id: t.id } });
    expect(second!.attemptId).not.toBe(first!.attemptId);
    expect(await e.rows(`select worker, outcome from taskgraph.attempts order by started_at, worker`))
      .toEqual([{ worker: 'w/1', outcome: 'expire' }, { worker: 'w/2', outcome: null }]);
  });

  it('puts boosted work first, and expiry keeps the boost', async () => {
    const e = await openEngine();
    await clock(e, T0);
    const sys = e.as('system');
    const a = await sys.tasks.create({ title: 'a', priority: 0 });
    const b = await sys.tasks.create({ title: 'b', priority: 4 });
    // b: claim, submit, followUp (boost)
    await e.as('developer').tasks.update(a.id, { holdUntil: new Date(T0.getTime() + 10 * HOUR) });
    await claim(e);
    await orc(e).move(b.id, 'submit');
    await orc(e).move(b.id, 'followUp');
    await e.as('developer').tasks.update(a.id, { holdUntil: null });
    expect((await claim(e))!.task.id).toBe(b.id);
    await clock(e, new Date(T0.getTime() + 2 * HOUR));
    expect(await e.tg.expireLeases()).toBe(1);
    expect((await e.tg.tasks.get(b.id)).boosted).toBe(true);
    expect((await claim(e))!.task.id).toBe(b.id);
  });
});

describe('expireLeases', { timeout: 30_000 }, () => {
  it('returns a lapsed lease through onLeaseExpiry: the task is open again and the attempt ends as expire', async () => {
    const e = await openEngine();
    await clock(e, T0);
    const t = await e.as('system').tasks.create({ title: 't' });
    const c = await claim(e);
    expect(await e.tg.expireLeases()).toBe(0);
    await clock(e, new Date(T0.getTime() + HOUR + 1));
    expect(await e.tg.expireLeases()).toBe(1);
    expect(await e.tg.tasks.get(t.id)).toMatchObject({ state: 'open', leaseAttemptId: null, claim: null });
    expect(await e.rows(`select outcome, ended_at from taskgraph.attempts`)).toEqual([{ outcome: 'expire', ended_at: new Date(T0.getTime() + HOUR + 1) }]);
    expect(await e.rows(`select actor, actor_role, attempt_id, from_state, to_state, payload from taskgraph.events where kind = 'move:expire'`))
      .toEqual([{ actor: 'system', actor_role: 'system', attempt_id: c!.attemptId, from_state: 'claimed', to_state: 'open', payload: { expiries: 1 } }]);
  });

  it('fires onRepeatedExpiry on the third expiry in a row; an attempt that ends otherwise restarts the count', async () => {
    const e = await openEngine();
    let now = T0.getTime();
    const tick = async () => { now += 2 * HOUR; await clock(e, new Date(now)); };
    await clock(e, T0);
    const t = await e.as('system').tasks.create({ title: 't' });
    const expireOnce = async () => { await claim(e); await tick(); await e.tg.expireLeases(); };

    await expireOnce();
    await expireOnce();
    // a submit between expiries starts the count again
    await claim(e);
    await orc(e).move(t.id, 'submit');
    await orc(e).move(t.id, 'followUp');
    await expireOnce();
    await expireOnce();
    expect((await e.tg.tasks.get(t.id)).state).toBe('open');
    await expireOnce();
    expect((await e.tg.tasks.get(t.id)).state).toBe('blocked');
    expect(await e.rows(`select outcome from taskgraph.attempts order by started_at`)).toEqual(
      ['expire', 'expire', 'submit', 'expire', 'expire', 'flag'].map(outcome => ({ outcome })));
    expect(await e.rows(`select payload from taskgraph.events where kind = 'move:flag'`)).toEqual([{ payload: { expiries: 3 } }]);
  });
});

describe('the expiry hooks', () => {
  it('may not land in a terminal state: the sweep can\'t refuse a move', () => {
    const lc = testLifecycle();
    lc.moves = lc.moves.map(m => (m.name === 'expire' ? { ...m, to: 'cancelled' } : m));
    expect(lifecycleViolations(lc).map(v => v.rule)).toContain('expiry-hooks');
  });
});

describe('heartbeat, fenced moves and resume', { timeout: 30_000 }, () => {
  it('heartbeat pushes the lease out, writes no event, and gets LeaseLost once another worker has the task', async () => {
    const e = await openEngine();
    await clock(e, T0);
    const t = await e.as('system').tasks.create({ title: 't' });
    const first = (await claim(e, 'w/1'))!;
    const events = async () => (await e.rows(`select count(*)::int n from taskgraph.events`))[0].n;
    const before = await events();
    await clock(e, new Date(T0.getTime() + HOUR / 2));
    const renewed = await orc(e).heartbeat(first, { leaseMs: HOUR });
    expect(renewed).toMatchObject({ attemptId: first.attemptId, expiresAt: new Date(T0.getTime() + HOUR / 2 + HOUR) });
    expect(await events()).toBe(before);

    // lapsed but not swept: the lease still belongs to its holder
    await clock(e, new Date(T0.getTime() + 2 * HOUR));
    await orc(e).heartbeat(first, { leaseMs: HOUR });
    // lapsed and taken over
    await clock(e, new Date(T0.getTime() + 4 * HOUR));
    const second = (await claim(e, 'w/2'))!;
    expect(second.task.id).toBe(t.id);
    await expect(orc(e).heartbeat(first, { leaseMs: HOUR })).rejects.toBeInstanceOf(LeaseLost);
    await orc(e).heartbeat(second, { leaseMs: HOUR });
  });

  it('moveClaimed is fenced by the attempt id, and ends the attempt', async () => {
    const e = await openEngine();
    await clock(e, T0);
    const t = await e.as('system').tasks.create({ title: 't' });
    const first = (await claim(e, 'w/1'))!;
    await orc(e).move(t.id, 'release');
    const second = (await claim(e, 'w/2'))!;
    await expect(orc(e).moveClaimed(first, 'submit')).rejects.toBeInstanceOf(LeaseLost);
    expect(await orc(e).moveClaimed(second, 'submit', { reason: 'pr open' })).toMatchObject({ state: 'waiting', leaseAttemptId: null });
    expect(await e.rows(`select outcome from taskgraph.attempts where id = $1`, [second.attemptId])).toEqual([{ outcome: 'submit' }]);
    await expect(orc(e).moveClaimed(second, 'finish')).rejects.toBeInstanceOf(LeaseLost);
  });

  it('a move out of the leased state by anyone takes the lease away', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    const c = (await claim(e))!;
    await e.as('developer').move(t.id, 'cancel');
    await expect(orc(e).heartbeat(c, { leaseMs: HOUR })).rejects.toBeInstanceOf(LeaseLost);
  });

  it('claims.resume returns the live attempt to its actor, and LeaseHeld names the holder to anyone else', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    const ann = e.tg.as({ id: 'ann', role: 'developer' });
    const bob = e.tg.as({ id: 'bob', role: 'developer' });
    const c = (await ann.claim({ worker: 'cli:ann@laptop', leaseMs: HOUR }))!;
    expect(await ann.claims.resume(t.id)).toEqual(c);
    const err = await bob.claims.resume(t.id).catch(x => x);
    expect(err).toBeInstanceOf(LeaseHeld);
    expect(err.holder).toBe('ann');
    const other = await e.as('system').tasks.create({ title: 'free' });
    await expect(ann.claims.resume(other.id)).rejects.toBeInstanceOf(NotFound);
  });
});

describe('review follow-ups (T2.2)', { timeout: 30_000 }, () => {
  it('heartbeat and claims.resume follow the claim move\'s roles', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    const c = (await claim(e))!;
    await expect(e.as('planner').heartbeat(c, { leaseMs: HOUR })).rejects.toBeInstanceOf(NotPermitted);
    await expect(e.as('planner').claims.resume(t.id)).rejects.toBeInstanceOf(NotPermitted);
  });
});
