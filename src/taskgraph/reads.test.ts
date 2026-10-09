import { describe, it, expect } from 'vitest';
import { openEngine, type TestEngine } from './test/engine';
import { InvalidRequest, NotFound } from './errors';

// Reads (engine spec, "API"): every read is on the project handle and takes no actor.

const ids = (xs: { id: string }[]) => xs.map(x => x.id);

/** A plan row, as plans.create will write it. */
async function plan(e: TestEngine, id: string, title = 'p') {
  await e.t.pglite.query(`insert into taskgraph.plans (project_id, id, title) values ($1, $2, $3)`, [e.tg.id, id, title]);
}

describe('tasks.list and count', { timeout: 30_000 }, () => {
  it('returns all 600 tasks when no limit is given', async () => {
    const e = await openEngine();
    await e.t.pglite.query(`
      insert into taskgraph.tasks (project_id, id, kind, title, state, origin)
      select $1, 'web-' || lpad(g::text, 4, '0'), 'work', 't' || g, 'proposed', 'manual' from generate_series(1, 600) g`, [e.tg.id]);
    expect(await e.tg.tasks.list()).toHaveLength(600);
    expect(await e.tg.tasks.count()).toBe(600);
    expect(await e.tg.tasks.list({ limit: 5 })).toHaveLength(5);
  });

  it('filters by state, kind, ids, key, parent, subtree, plan, origin and tags', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const dev = e.as('developer');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const sub = await sys.tasks.create({ title: 'sub', kind: 'container', parent: epic.id });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id, tags: ['ui', 'web'] });
    const b = await dev.tasks.create({ title: 'b', parent: sub.id, key: 'k-b', tags: ['ui'] });
    await plan(e, 'web-plan-1');
    const c = await e.as('planner').tasks.create({ title: 'c', plan: 'web-plan-1' });

    expect(ids(await e.tg.tasks.list({ states: ['proposed'], orderBy: 'created' }))).toEqual([b.id, c.id]);
    expect(ids(await e.tg.tasks.list({ kind: 'container', orderBy: 'created' }))).toEqual([epic.id, sub.id]);
    expect(ids(await e.tg.tasks.list({ ids: [c.id, a.id], orderBy: 'created' }))).toEqual([a.id, c.id]);
    expect(ids(await e.tg.tasks.list({ key: 'k-b' }))).toEqual([b.id]);
    expect(ids(await e.tg.tasks.list({ parent: epic.id, orderBy: 'created' }))).toEqual([sub.id, a.id]);
    expect(ids(await e.tg.tasks.list({ within: epic.id, orderBy: 'created' }))).toEqual([sub.id, a.id, b.id]);
    expect(ids(await e.tg.tasks.list({ plan: 'web-plan-1' }))).toEqual([c.id]);
    expect(ids(await e.tg.tasks.list({ origin: ['manual'] }))).toEqual([b.id]);
    expect(ids(await e.tg.tasks.list({ tags: ['ui', 'web'] }))).toEqual([a.id]);
    expect(await e.tg.tasks.count({ tags: ['ui'] })).toBe(2);
  });

  it('orders by claim order by default, or by created, updated or closed time', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const low = await sys.tasks.create({ title: 'low', priority: 3 });
    const high = await sys.tasks.create({ title: 'high', priority: 0 });
    expect(ids(await e.tg.tasks.list())).toEqual([high.id, low.id]);
    expect(ids(await e.tg.tasks.list({ orderBy: 'created' }))).toEqual([low.id, high.id]);
    await e.as('developer').tasks.update(low.id, { title: 'low!' });
    expect(ids(await e.tg.tasks.list({ orderBy: 'updated' }))).toEqual([high.id, low.id]);
    await e.as('developer').move(high.id, 'cancel');
    expect(ids(await e.tg.tasks.list({ orderBy: 'closed' }))).toEqual([high.id, low.id]);
  });

  it('refuses a malformed filter with InvalidRequest', async () => {
    const e = await openEngine();
    await expect(e.tg.tasks.list({ limit: -1 })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.tg.tasks.list({ orderBy: 'random' } as any)).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.tg.tasks.list({ nope: 1 } as any)).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe('tasks.get', { timeout: 30_000 }, () => {
  it('returns the task with its dependencies, their states, and its live claim', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const base = await sys.tasks.create({ title: 'base' });
    const t = await sys.tasks.create({ title: 't' });
    await e.as('developer').deps.add(t.id, base.id);
    expect(await e.tg.tasks.get(t.id)).toMatchObject({ id: t.id, deps: [{ id: base.id, state: 'open' }], claim: null });

    // a lease, as claim will write it
    await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor)
                            values ('00000000-0000-0000-0000-0000000000a1', $1, $2, 'w/1', 'orc')`, [e.tg.id, base.id]);
    await e.t.pglite.query(`update taskgraph.tasks set state = 'claimed', lease_attempt_id = '00000000-0000-0000-0000-0000000000a1',
                            lease_expires_at = now() + interval '1 hour' where id = $1`, [base.id]);
    expect((await e.tg.tasks.get(base.id)).claim).toMatchObject({
      attemptId: '00000000-0000-0000-0000-0000000000a1', worker: 'w/1', actor: 'orc', expiresAt: expect.any(Date),
    });
    await expect(e.tg.tasks.get('web-nope')).rejects.toBeInstanceOf(NotFound);
  });
});

describe('children and subtree', { timeout: 30_000 }, () => {
  it('lists direct children, and every task below', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const sub = await sys.tasks.create({ title: 'sub', kind: 'container', parent: epic.id });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const b = await sys.tasks.create({ title: 'b', parent: sub.id });
    expect(ids(await e.tg.tasks.children(epic.id))).toEqual([sub.id, a.id]);
    expect(ids(await e.tg.tasks.subtree(epic.id))).toEqual([sub.id, a.id, b.id]);
    await expect(e.tg.tasks.children('web-nope')).rejects.toBeInstanceOf(NotFound);
  });
});

describe('history and events.since', { timeout: 30_000 }, () => {
  it('lists a task\'s events oldest first, notes included', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await e.as('developer').notes.add(t.id, 'hello');
    await e.as('developer').move(t.id, 'approve');
    const h = await e.tg.tasks.history(t.id);
    expect(h.map(x => x.kind)).toEqual(['task.created', 'note', 'move:approve']);
    expect(h[1]).toMatchObject({ taskId: t.id, actor: 'developer', actorRole: 'developer', payload: { text: 'hello' } });
    expect(h[2]).toMatchObject({ fromState: 'proposed', toState: 'open', at: expect.any(Date) });
  });

  it('pages through the project\'s events after a cursor, and none of another project\'s', async () => {
    const e = await openEngine();
    const other = await e.client.projects.create({ name: 'api', idPrefix: 'api', actor: { id: 'a', role: 'developer' } });
    await e.client.project(other.id).as({ id: 's', role: 'system' }).tasks.create({ title: 'elsewhere' });
    await e.as('system').tasks.create({ title: 'one' });
    await e.as('system').tasks.create({ title: 'two' });

    const all = await e.tg.events.since('0', 100);
    expect(all.map(x => x.kind)).toEqual(['project.created', 'task.created', 'task.created']);
    const page = await e.tg.events.since(all[0].id, 1);
    expect(page.map(x => x.id)).toEqual([all[1].id]);
    expect(await e.tg.events.since(all[2].id, 100)).toEqual([]);
    await expect(e.tg.events.since('x', 10)).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe('tasks.search', { timeout: 30_000 }, () => {
  it('finds a task by a word in its description, and by exact id or key', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const t = await sys.tasks.create({ title: 'Login page', description: 'The button flickers on hover', key: 'gap-77' });
    await sys.tasks.create({ title: 'Other', description: 'unrelated' });
    expect(ids(await e.tg.tasks.search('flickers'))).toEqual([t.id]);
    expect(ids(await e.tg.tasks.search('LOGIN'))).toEqual([t.id]);
    expect(ids(await e.tg.tasks.search(t.id))).toEqual([t.id]);
    expect(ids(await e.tg.tasks.search('gap-77'))).toEqual([t.id]);
    expect(await e.tg.tasks.search('nothing-here')).toEqual([]);
    expect(await e.tg.tasks.search('  ')).toEqual([]);
  });
});

describe('plans and attempts', { timeout: 30_000 }, () => {
  it('reads plans by id and lists them', async () => {
    const e = await openEngine();
    await plan(e, 'web-plan-a', 'first');
    await plan(e, 'web-plan-b', 'second');
    expect(await e.tg.plans.get('web-plan-a')).toMatchObject({ id: 'web-plan-a', title: 'first', approvedAt: null, discardedAt: null });
    expect(ids(await e.tg.plans.list())).toEqual(['web-plan-a', 'web-plan-b']);
    await expect(e.tg.plans.get('web-plan-z')).rejects.toBeInstanceOf(NotFound);
  });

  it('lists a task\'s attempts oldest first', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    for (const [n, at] of [['1', '2026-01-01'], ['2', '2026-01-02']]) {
      await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor, started_at)
                              values ($1, $2, $3, 'w', 'orc', $4)`, [`00000000-0000-0000-0000-00000000000${n}`, e.tg.id, t.id, at]);
    }
    expect((await e.tg.attempts.list(t.id)).map(a => a.id))
      .toEqual(['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002']);
  });
});

describe('ready(filter)', { timeout: 30_000 }, () => {
  it('takes the task filter, such as within', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    await sys.tasks.create({ title: 'loose' });
    expect(ids(await e.tg.ready({ within: epic.id }))).toEqual([a.id]);
  });
});

describe('review follow-ups', { timeout: 30_000 }, () => {
  it('reports a lapsed lease as expired, by the database clock', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor)
                            values ('00000000-0000-0000-0000-0000000000b1', $1, $2, 'w/1', 'orc')`, [e.tg.id, t.id]);
    await e.t.pglite.query(`update taskgraph.tasks set state = 'claimed', lease_attempt_id = '00000000-0000-0000-0000-0000000000b1',
                            lease_expires_at = now() - interval '1 minute' where id = $1`, [t.id]);
    expect((await e.tg.tasks.get(t.id)).claim).toMatchObject({ expired: true });
    await e.t.pglite.query(`update taskgraph.tasks set lease_expires_at = now() + interval '1 hour' where id = $1`, [t.id]);
    expect((await e.tg.tasks.get(t.id)).claim).toMatchObject({ expired: false });
  });

  it('filters plans by status', async () => {
    const e = await openEngine();
    await plan(e, 'web-plan-a');
    await plan(e, 'web-plan-b');
    await plan(e, 'web-plan-c');
    await e.t.pglite.query(`update taskgraph.plans set approved_at = now(), approved_by = 'x' where id = 'web-plan-b'`);
    await e.t.pglite.query(`update taskgraph.plans set discarded_at = now(), discarded_by = 'x' where id = 'web-plan-c'`);
    expect(ids(await e.tg.plans.list({ status: ['open'] }))).toEqual(['web-plan-a']);
    expect(ids(await e.tg.plans.list({ status: ['approved', 'discarded'] }))).toEqual(['web-plan-b', 'web-plan-c']);
    await expect(e.tg.plans.list({ status: ['nope'] } as any)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('never returns another project\'s rows', async () => {
    const e = await openEngine();
    const other = await e.client.projects.create({ name: 'web2', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg2 = e.client.project(other.id);
    const mine = await e.as('system').tasks.create({ title: 'shared words', key: 'k1', kind: 'container' });
    // the same id, key, title and shape in the other project
    await e.t.pglite.exec(`
      insert into taskgraph.tasks (project_id, id, key, kind, title, state, origin) values ($1, $2, 'k1', 'container', 'shared words', 'open', 'system');
      insert into taskgraph.tasks (project_id, id, kind, title, state, origin, parent_id) values ($1, $2 || '.1', 'work', 'child', 'open', 'system', $2);
      insert into taskgraph.attempts (id, project_id, task_id, worker, actor) values (gen_random_uuid(), $1, $2, 'w', 'x');
    `.replace(/\$1/g, `'${other.id}'`).replace(/\$2/g, `'${mine.id}'`).trim());
    await tg2.tasks.get(mine.id);

    expect(await e.tg.tasks.count()).toBe(1);
    expect(ids(await e.tg.tasks.search('shared'))).toEqual([mine.id]);
    expect(ids(await e.tg.tasks.search('k1'))).toEqual([mine.id]);
    expect(await e.tg.tasks.subtree(mine.id)).toEqual([]);
    expect(await e.tg.tasks.children(mine.id)).toEqual([]);
    expect(await e.tg.attempts.list(mine.id)).toEqual([]);
    expect((await e.tg.tasks.history(mine.id)).every(x => x.projectId === e.tg.id)).toBe(true);
    expect(ids(await tg2.tasks.subtree(mine.id))).toEqual([`${mine.id}.1`]);
  });
});
