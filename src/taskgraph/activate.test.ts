import { describe, it, expect } from 'vitest';
import { openEngine, type TestEngine } from './test/engine';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph } from './client';
import { defineGuard, lifecycleViolations, type Lifecycle } from './lifecycle';
import { InvalidRequest, NotFound, NotPermitted, VersionMismatch } from './errors';

// Lifecycle versions (engine spec, "Versions and upgrades"): diff previews,
// activate applies, and older processes are fenced out after.

/** Version 2: parked goes (its tasks to blocked), review arrives, finish's guard changes, approve gains a role. */
function v2(): Lifecycle {
  const lc = testLifecycle();
  lc.version = 2;
  delete lc.states.parked;
  lc.states.review = {};
  lc.moves = lc.moves.filter(m => m.name !== 'park' && m.name !== 'unpark').map(m => {
    if (m.name === 'cancel') return { ...m, from: m.from.filter(s => s !== 'parked').concat('review') };
    if (m.name === 'finish') return { ...m, guard: defineGuard('checksPassedV2', async () => true) };
    if (m.name === 'approve') return { ...m, by: ['developer', 'planner'] };
    return m;
  });
  lc.moves.push({ name: 'toReview', from: ['open'], to: 'review', by: ['developer'] });
  lc.permissions['tasks.update'] = { developer: ['proposed', 'open', 'blocked', 'review'], planner: ['proposed'] };
  lc.migrate = { parked: 'blocked' };
  return lc;
}

/** A lease on a task, as claim writes it, live for an hour or lapsed a minute ago. */
async function lease(e: TestEngine, taskId: string, attempt: string, live = true) {
  await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor) values ($1, $2, $3, 'w/9', 'orc')`,
    [attempt, e.tg.id, taskId]);
  await e.t.pglite.query(`update taskgraph.tasks set state = 'claimed', lease_attempt_id = $1,
    lease_expires_at = now() + ${live ? "interval '1 hour'" : "interval '-1 minute'"} where id = $2`, [attempt, taskId]);
}

async function setup() {
  const e = await openEngine();
  const parked = await e.as('system').tasks.create({ title: 'parked' });
  await e.as('developer').move(parked.id, 'park');
  const open = await e.as('system').tasks.create({ title: 'open' });
  const next = await openTaskGraph({ db: e.t.db, lifecycle: v2() });
  const tg2 = next.project(e.tg.id);
  return { e, parked, open, next, tg2, as2: (role: string) => tg2.as({ id: role, role }) };
}

describe('lifecycles.diff', { timeout: 30_000 }, () => {
  it('lists states, moves, roles and guards changed, the tasks the mapping moves, and live leases', async () => {
    const { e, parked, open } = await setup();
    await lease(e, open.id, '00000000-0000-0000-0000-0000000000d1');
    const d = await e.tg.lifecycles.diff(2);
    expect(d).toMatchObject({
      from: { name: 'test.task', version: 1 }, to: { name: 'test.task', version: 2 },
      states: { added: ['review'], removed: ['parked'] },
      moves: { added: ['toReview'], removed: ['park', 'unpark'] },
      roles: [{ move: 'approve', added: ['planner'], removed: [] }],
      guards: [{ move: 'finish', from: 'checksPassed', to: 'checksPassedV2' }],
      tasks: [{ id: parked.id, from: 'parked', to: 'blocked' }],
      leases: [{ taskId: open.id, worker: 'w/9', attemptId: '00000000-0000-0000-0000-0000000000d1', live: true }],
      unmapped: [],
    });
    await expect(e.tg.lifecycles.diff(7)).rejects.toBeInstanceOf(NotFound);
  });
});

describe('lifecycles.activate', { timeout: 30_000 }, () => {
  it('moves mapped tasks, makes the version active, writes lifecycle.upgraded, and fences out the old process', async () => {
    const { e, parked, open, as2, tg2 } = await setup();
    // before activation the newer process reads but can't write
    expect((await tg2.tasks.get(parked.id)).state).toBe('parked');
    await expect(as2('developer').tasks.update(open.id, { title: 'x' })).rejects.toBeInstanceOf(VersionMismatch);

    await as2('developer').lifecycles.activate(2);
    expect((await tg2.tasks.get(parked.id)).state).toBe('blocked');
    expect(await e.client.projects.get(e.tg.id)).toMatchObject({ lifecycleVersion: 2 });
    expect(await e.rows(`select task_id, from_state, to_state, actor, payload->>'from' as f, payload->>'to' as t
                           from taskgraph.events where kind = 'lifecycle.upgraded' order by id`)).toEqual([
      { task_id: parked.id, from_state: 'parked', to_state: 'blocked', actor: 'developer', f: null, t: null },
      { task_id: null, from_state: null, to_state: null, actor: 'developer', f: '1', t: '2' },
    ]);

    await expect(e.as('developer').tasks.update(open.id, { title: 'old' })).rejects.toBeInstanceOf(VersionMismatch);
    await expect(e.t.pglite.query(`update taskgraph.tasks set state = 'parked' where id = $1`, [parked.id])).rejects.toThrow(/not a state/);
    expect(await as2('developer').move(open.id, 'toReview')).toMatchObject({ state: 'review' });
  });

  it('refuses while a lease is live, naming the worker, unless forced; a forced or lapsed lease ends as expiry would', async () => {
    const { e, open, as2, tg2 } = await setup();
    await lease(e, open.id, '00000000-0000-0000-0000-0000000000d2');
    const err = await as2('developer').lifecycles.activate(2).catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(/w\/9/);

    await as2('developer').lifecycles.activate(2, { force: true });
    expect(await tg2.tasks.get(open.id)).toMatchObject({ state: 'open', leaseAttemptId: null, claim: null });
    expect(await e.rows(`select outcome, ended_at is not null as ended from taskgraph.attempts`)).toEqual([{ outcome: 'expire', ended: true }]);
  });

  it('ends a lapsed lease without force', async () => {
    const { e, open, as2, tg2 } = await setup();
    await lease(e, open.id, '00000000-0000-0000-0000-0000000000d3', false);
    await as2('developer').lifecycles.activate(2);
    expect((await tg2.tasks.get(open.id)).state).toBe('open');
  });

  it('rolls back to an older version, refused while a task sits in a state that version lacks', async () => {
    const { e, open, as2 } = await setup();
    await as2('developer').lifecycles.activate(2);
    await as2('developer').move(open.id, 'toReview');
    const old = e.as('developer');
    const err = await old.lifecycles.activate(1).catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(/review/);
    await as2('developer').move(open.id, 'cancel');
    await old.lifecycles.activate(1);
    expect(await e.client.projects.get(e.tg.id)).toMatchObject({ lifecycleVersion: 1 });
  });

  it('is permitted by the lifecycle\'s role rules, and only for the version this process runs', async () => {
    const { as2 } = await setup();
    await expect(as2('planner').lifecycles.activate(2)).rejects.toBeInstanceOf(NotPermitted);
    await expect(as2('developer').lifecycles.activate(1)).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe('the migrate map', () => {
  it('names only states this version removed, and never maps into the leased state', () => {
    const lc = v2();
    lc.migrate = { open: 'blocked' };
    expect(lifecycleViolations(lc).map(v => v.rule)).toContain('migrate-map');
    lc.migrate = { parked: 'claimed' };
    expect(lifecycleViolations(lc).map(v => v.rule)).toContain('migrate-map');
  });
});

describe('review follow-ups', { timeout: 30_000 }, () => {
  it('refuses a state that disappears without a migrate entry, naming the tasks', async () => {
    const { e, parked } = await setup();
    const v3 = v2();
    v3.version = 3;
    delete v3.migrate;
    const next = await openTaskGraph({ db: e.t.db, lifecycle: v3 });
    const d = await next.project(e.tg.id).lifecycles.diff(3);
    expect(d.unmapped).toEqual([{ state: 'parked', tasks: [parked.id] }]);
    const err = await next.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(3).catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(new RegExp(`parked.*${parked.id}`));
  });

  it('refuses when already on the version, and records the ended attempt on the task\'s event', async () => {
    const { e, open, as2 } = await setup();
    await lease(e, open.id, '00000000-0000-0000-0000-0000000000d4', false);
    await as2('developer').lifecycles.activate(2);
    expect(await e.rows(`select attempt_id from taskgraph.events where kind = 'lifecycle.upgraded' and task_id = $1`, [open.id]))
      .toEqual([{ attempt_id: '00000000-0000-0000-0000-0000000000d4' }]);
    await expect(as2('developer').lifecycles.activate(2)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('refuses a mapping that would close a container over live children, or strand dependents', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    await sys.tasks.create({ title: 'child', parent: epic.id });
    await e.as('developer').move(epic.id, 'park');
    const v = v2();
    v.migrate = { parked: 'cancelled' };
    const next = await openTaskGraph({ db: e.t.db, lifecycle: v });
    const err = await next.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(2).catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(/live child/);

    const e2 = await openEngine();
    const base = await e2.as('system').tasks.create({ title: 'base' });
    const w = await e2.as('system').tasks.create({ title: 'w' });
    await e2.as('developer').deps.add(w.id, base.id);
    await e2.as('developer').move(base.id, 'park');
    const next2 = await openTaskGraph({ db: e2.t.db, lifecycle: v });
    const err2 = await next2.project(e2.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(2).catch(x => x);
    expect(err2).toBeInstanceOf(InvalidRequest);
    expect(err2.message).toMatch(/waits on/);
  });

  it('writes children.settled when the mapping settles a container', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const c = await sys.tasks.create({ title: 'child', parent: epic.id });
    await e.as('developer').move(c.id, 'park');
    const v = v2();
    v.migrate = { parked: 'cancelled' };
    const next = await openTaskGraph({ db: e.t.db, lifecycle: v });
    await next.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(2);
    expect(await e.rows(`select task_id from taskgraph.events where kind = 'children.settled'`)).toEqual([{ task_id: epic.id }]);
  });

  it('lists changed state flags, moves, hooks and permissions in the diff', async () => {
    const e = await openEngine();
    const v = v2();
    v.states.waiting = { satisfiesDeps: true };
    v.moves = v.moves.map(m => (m.name === 'expire' ? { ...m, to: 'blocked' } : m));
    v.permissions['notes.add'] = { developer: true };
    await openTaskGraph({ db: e.t.db, lifecycle: v });
    const d = await e.tg.lifecycles.diff(2);
    expect(d.flags).toEqual([{ state: 'waiting', from: {}, to: { satisfiesDeps: true } }]);
    expect(d.changedMoves).toEqual(expect.arrayContaining(['expire']));
    expect(d.permissions).toEqual(expect.arrayContaining(['notes.add', 'tasks.update']));
  });

  it('on rollback, ignores the older version\'s migrate map and refuses tasks in states it lacks', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    // v2 drops parked (mapped to blocked); v3 brings it back
    const lc2 = v2();
    const two = await openTaskGraph({ db: e.t.db, lifecycle: lc2 });
    await two.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(2);
    const lc3 = testLifecycle();
    lc3.version = 3;
    const three = await openTaskGraph({ db: e.t.db, lifecycle: lc3 });
    await three.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(3);
    await three.project(e.tg.id).as({ id: 'd', role: 'developer' }).move(t.id, 'park');
    const err = await two.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(2).catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(/parked/);
  });

  it('applies the expiry move\'s boost flags to a lease it ends', async () => {
    const lc1 = testLifecycle();
    lc1.moves = lc1.moves.map(m => (m.name === 'expire' ? { ...m, boost: true } : m));
    const e = await openEngine(lc1);
    const t = await e.as('system').tasks.create({ title: 't' });
    await lease(e, t.id, '00000000-0000-0000-0000-0000000000d5', false);
    const lc = v2();
    lc.moves = lc.moves.map(m => (m.name === 'expire' ? { ...m, boost: true } : m));
    const next = await openTaskGraph({ db: e.t.db, lifecycle: lc });
    await next.project(e.tg.id).as({ id: 'd', role: 'developer' }).lifecycles.activate(2);
    expect((await next.project(e.tg.id).tasks.get(t.id)).boosted).toBe(true);
  });
});
