import { describe, it, expect } from 'vitest';
import { openEngine } from './test/engine';
import { CycleError, NotFound, NotPermitted } from './errors';

describe('deps', { timeout: 30_000 }, () => {
  it('refuses an edge that would close a cycle: A on B, B on C, then C on A', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const [a, b, c] = [await p.tasks.create({ title: 'a' }), await p.tasks.create({ title: 'b' }), await p.tasks.create({ title: 'c' })];
    await p.deps.add(a.id, b.id);
    await p.deps.add(b.id, c.id);
    const err = await p.deps.add(c.id, a.id).catch(x => x);
    expect(err).toBeInstanceOf(CycleError);
    expect(err).toMatchObject({ taskId: c.id, dependsOnId: a.id });
    expect(await e.rows(`select count(*)::int as n from taskgraph.task_deps`)).toEqual([{ n: 2 }]);
  });

  it('refuses a task depending on itself', async () => {
    const e = await openEngine();
    const a = await e.as('planner').tasks.create({ title: 'a' });
    await expect(e.as('planner').deps.add(a.id, a.id)).rejects.toBeInstanceOf(CycleError);
  });

  it('writes dep.added once, and dep.removed when the edge goes', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const a = await p.tasks.create({ title: 'a' });
    const b = await p.tasks.create({ title: 'b' });
    await p.deps.add(a.id, b.id);
    await p.deps.add(a.id, b.id);
    await p.deps.remove(a.id, b.id);
    expect(await e.rows(`select kind, task_id, payload from taskgraph.events where kind like 'dep.%' order by id`)).toEqual([
      { kind: 'dep.added', task_id: a.id, payload: { dependsOnId: b.id } },
      { kind: 'dep.removed', task_id: a.id, payload: { dependsOnId: b.id } },
    ]);
    await expect(p.deps.remove(a.id, b.id)).rejects.toBeInstanceOf(NotFound);
  });

  it('checks the state of the task that waits, and that both tasks exist', async () => {
    const e = await openEngine();
    const open = await e.as('system').tasks.create({ title: 'open' });
    const prop = await e.as('planner').tasks.create({ title: 'proposed' });
    await expect(e.as('planner').deps.add(open.id, prop.id)).rejects.toBeInstanceOf(NotPermitted);
    await e.as('planner').deps.add(prop.id, open.id);
    await expect(e.as('planner').deps.add(prop.id, 'web-nope')).rejects.toBeInstanceOf(NotFound);
  });
});

describe('links and notes', { timeout: 30_000 }, () => {
  it('add a non-blocking link once, with link.added', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const a = await p.tasks.create({ title: 'a' });
    const b = await p.tasks.create({ title: 'b' });
    await e.as('agent').links.add(a.id, b.id, 'discovered-from');
    await e.as('agent').links.add(a.id, b.id, 'discovered-from');
    expect(await e.rows(`select a, b, kind from taskgraph.task_links`)).toEqual([{ a: a.id, b: b.id, kind: 'discovered-from' }]);
    expect(await e.rows(`select count(*)::int as n from taskgraph.events where kind = 'link.added'`)).toEqual([{ n: 1 }]);
  });

  it('add a note as an event on the task', async () => {
    const e = await openEngine();
    const a = await e.as('planner').tasks.create({ title: 'a' });
    await e.as('orchestrator').notes.add(a.id, 'tried twice');
    expect(await e.rows(`select task_id, actor_role, payload from taskgraph.events where kind = 'note'`))
      .toEqual([{ task_id: a.id, actor_role: 'orchestrator', payload: { text: 'tried twice' } }]);
    await expect(e.as('planner').notes.add(a.id, 'nope')).rejects.toBeInstanceOf(NotPermitted);
  });
});
