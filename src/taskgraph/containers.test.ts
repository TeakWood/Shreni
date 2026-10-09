import { describe, it, expect } from 'vitest';
import { openEngine, type TestEngine } from './test/engine';
import { InvalidRequest, MoveRefused } from './errors';

// Containers and dependents (engine spec, "Containers" and "Cancelled work
// doesn't strand its dependents").

/** Puts a task in claimed by raw SQL, as a claim would, so finish can run. */
async function claimed(e: TestEngine, id: string) {
  await e.t.pglite.query(`update taskgraph.tasks set state = 'claimed' where id = $1`, [id]);
}

const ids = (tasks: { id: string }[]) => tasks.map(t => t.id);

describe('ready()', { timeout: 30_000 }, () => {
  it('lists none of a parked epic\'s children, at any depth', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const sub = await sys.tasks.create({ title: 'sub', kind: 'container', parent: epic.id });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const b = await sys.tasks.create({ title: 'b', parent: sub.id });
    const loose = await sys.tasks.create({ title: 'loose' });
    expect(ids(await e.tg.ready()).sort()).toEqual([a.id, b.id, loose.id].sort());

    await e.as('developer').move(epic.id, 'park');
    expect(ids(await e.tg.ready())).toEqual([loose.id]);
    await e.as('developer').move(epic.id, 'unpark');
    expect(ids(await e.tg.ready()).sort()).toEqual([a.id, b.id, loose.id].sort());
  });

  it('leaves out containers, held tasks and tasks with unsatisfied dependencies, in claim order', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    await sys.tasks.create({ title: 'c', kind: 'container' });
    const low = await sys.tasks.create({ title: 'low', priority: 3 });
    const high = await sys.tasks.create({ title: 'high', priority: 1 });
    const held = await sys.tasks.create({ title: 'held' });
    await e.as('developer').tasks.update(held.id, { holdUntil: new Date(Date.now() + 3_600_000) });
    const waits = await sys.tasks.create({ title: 'waits' });
    await e.as('developer').deps.add(waits.id, low.id);
    expect(ids(await e.tg.ready())).toEqual([high.id, low.id]);

    await claimed(e, low.id);
    await e.as('developer').move(low.id, 'finish');
    expect(ids(await e.tg.ready())).toEqual([high.id, waits.id]);
    expect(ids(await e.tg.ready({ limit: 1 }))).toEqual([high.id]);
  });
});

describe('containers', { timeout: 30_000 }, () => {
  it('refuse a terminal move over live children with ChildrenLive', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const err = await e.as('developer').move(epic.id, 'completeContainer').catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    expect(err).toMatchObject({ reason: 'ChildrenLive', state: 'open' });
    await e.as('developer').move(a.id, 'cancel');
    expect(await e.as('developer').move(epic.id, 'completeContainer')).toMatchObject({ state: 'done' });
  });

  it('refuse a child under a terminal container, created or moved there', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    await e.as('developer').move(epic.id, 'cancel');
    await expect(sys.tasks.create({ title: 'a', parent: epic.id })).rejects.toBeInstanceOf(InvalidRequest);
    const loose = await sys.tasks.create({ title: 'loose' });
    await expect(e.as('developer').tasks.update(loose.id, { parent: epic.id })).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('write children.settled once, when the last child settles, and list the container in settled()', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const dev = e.as('developer');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const empty = await sys.tasks.create({ title: 'empty', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const b = await sys.tasks.create({ title: 'b', parent: epic.id });
    const settled = () => e.rows(`select task_id from taskgraph.events where kind = 'children.settled'`);

    await dev.move(a.id, 'cancel');
    expect(await settled()).toEqual([]);
    expect(await e.tg.tasks.settled()).toEqual([]);

    await claimed(e, b.id);
    await dev.move(b.id, 'finish');
    expect(await settled()).toEqual([{ task_id: epic.id }]);
    expect(ids(await e.tg.tasks.settled())).toEqual([epic.id]);
    expect(ids(await e.tg.tasks.settled())).not.toContain(empty.id);

    // a parked container isn't listed: settled() is for containers a caller would complete
    await dev.move(epic.id, 'park');
    expect(await e.tg.tasks.settled()).toEqual([]);
  });
});

describe('dependents', { timeout: 30_000 }, () => {
  it('refuse a cancel while live tasks wait on it, naming them, unless dropDeps', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const dev = e.as('developer');
    const base = await sys.tasks.create({ title: 'base' });
    const w1 = await sys.tasks.create({ title: 'w1' });
    const w2 = await sys.tasks.create({ title: 'w2' });
    const gone = await sys.tasks.create({ title: 'gone' });
    for (const w of [w1, w2, gone]) await dev.deps.add(w.id, base.id);
    await dev.move(gone.id, 'cancel'); // a terminal dependent doesn't count

    const err = await dev.move(base.id, 'cancel').catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    expect(err).toMatchObject({ reason: 'DependentsLive', waiting: [w1.id, w2.id].sort() });

    await dev.move(base.id, 'cancel', { dropDeps: true, requestId: 'r9' });
    expect(await e.rows(`select task_id from taskgraph.task_deps where depends_on_id = $1 order by task_id`, [base.id]))
      .toEqual([{ task_id: gone.id }]);
    expect(await e.rows(`select task_id, payload from taskgraph.events where kind = 'dep.removed' order by task_id`))
      .toEqual([w1, w2].sort((x, y) => x.id.localeCompare(y.id))
        .map(w => ({ task_id: w.id, payload: { dependsOnId: base.id, reason: 'dropped' } })));
  });

  it('allow a move into a state that satisfies dependencies', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const base = await sys.tasks.create({ title: 'base' });
    const w = await sys.tasks.create({ title: 'w' });
    await e.as('developer').deps.add(w.id, base.id);
    await claimed(e, base.id);
    expect(await e.as('developer').move(base.id, 'finish')).toMatchObject({ state: 'done' });
  });
});

describe('ready() input', { timeout: 30_000 }, () => {
  it('refuses a limit that isn\'t a whole number', async () => {
    const e = await openEngine();
    await expect(e.tg.ready({ limit: -1 })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.tg.ready({ limit: 1.5 })).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe('review follow-ups', { timeout: 30_000 }, () => {
  it('refuse a dependency on a task that closed without satisfying dependencies', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const dev = e.as('developer');
    const base = await sys.tasks.create({ title: 'base' });
    const w = await sys.tasks.create({ title: 'w' });
    await dev.move(base.id, 'cancel');
    await expect(dev.deps.add(w.id, base.id)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('carry the live children on ChildrenLive, apart from waiting tasks', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const err = await e.as('developer').move(epic.id, 'completeContainer').catch(x => x);
    expect(err).toMatchObject({ reason: 'ChildrenLive', children: [a.id], waiting: [] });
    expect(err.message).toMatch(/live children/);
  });

  it('write children.settled when deleting or reparenting the last live child settles a container', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const dev = e.as('developer');
    const settled = () => e.rows(`select task_id from taskgraph.events where kind = 'children.settled' order by id`);

    const e1 = await sys.tasks.create({ title: 'e1', kind: 'container' });
    const done1 = await sys.tasks.create({ title: 'd', parent: e1.id });
    await dev.move(done1.id, 'cancel');
    expect(await settled()).toEqual([{ task_id: e1.id }]);
    const p = await e.as('planner').tasks.create({ title: 'p', parent: e1.id });
    await e.as('planner').tasks.delete(p.id);
    expect(await settled()).toEqual([{ task_id: e1.id }, { task_id: e1.id }]);

    const e2 = await sys.tasks.create({ title: 'e2', kind: 'container' });
    const x = await sys.tasks.create({ title: 'x', parent: e2.id });
    const y = await sys.tasks.create({ title: 'y', parent: e2.id });
    await dev.move(x.id, 'cancel');
    await dev.tasks.update(y.id, { parent: null });
    expect((await settled()).at(-1)).toEqual({ task_id: e2.id });
  });
});
