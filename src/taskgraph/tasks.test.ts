import { describe, it, expect } from 'vitest';
import { openEngine } from './test/engine';
import { testLifecycle } from './test/lifecycle';
import { InvalidRequest, NotFound, NotPermitted } from './errors';

describe('tasks.create', { timeout: 30_000 }, () => {
  it('puts a planner\'s task in create.state, whatever the input says', async () => {
    const e = await openEngine();
    const task = await e.as('planner').tasks.create({ title: 'Do it', state: 'open' } as any);
    expect(task).toMatchObject({ title: 'Do it', state: 'proposed', kind: 'work', origin: 'manual', priority: 2, parentId: null });
    expect(task.id).toMatch(/^web-[0-9a-z]{3}$/);
  });

  it('lands a system task where create.byRole says, with origin system; an agent\'s gets origin agent', async () => {
    const e = await openEngine();
    expect(await e.as('system').tasks.create({ title: 'repair main' })).toMatchObject({ state: 'open', origin: 'system' });
    expect(await e.as('agent').tasks.create({ title: 'found a gap' })).toMatchObject({ state: 'proposed', origin: 'agent' });
  });

  it('files a task into an open plan with origin plan, and refuses a plan that is approved or discarded', async () => {
    const e = await openEngine();
    await e.t.pglite.exec(`insert into taskgraph.plans (project_id, id, title) values ('${e.tg.id}', 'web-plan-aaa', 'p'),
      ('${e.tg.id}', 'web-plan-bbb', 'q')`);
    await e.t.pglite.exec(`update taskgraph.plans set approved_at = now(), approved_by = 'ann' where id = 'web-plan-bbb'`);
    expect(await e.as('planner').tasks.create({ title: 't', plan: 'web-plan-aaa' })).toMatchObject({ origin: 'plan', planId: 'web-plan-aaa' });
    await expect(e.as('planner').tasks.create({ title: 't', plan: 'web-plan-bbb' })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.as('planner').tasks.create({ title: 't', plan: 'web-plan-zzz' })).rejects.toBeInstanceOf(NotFound);
  });

  it('puts a plan\'s task in create.state even for a role byRole would open', async () => {
    const e = await openEngine();
    await e.t.pglite.exec(`insert into taskgraph.plans (project_id, id, title) values ('${e.tg.id}', 'web-plan-aaa', 'p')`);
    expect(await e.as('system').tasks.create({ title: 't', plan: 'web-plan-aaa' })).toMatchObject({ state: 'proposed', origin: 'plan' });
  });

  it('gives a child its parent\'s id plus .<n>', async () => {
    const e = await openEngine();
    const epic = await e.as('planner').tasks.create({ title: 'epic', kind: 'container' });
    const a = await e.as('planner').tasks.create({ title: 'a', parent: epic.id });
    const b = await e.as('planner').tasks.create({ title: 'b', parent: epic.id });
    expect([a.id, b.id]).toEqual([`${epic.id}.1`, `${epic.id}.2`]);
    expect(a.parentId).toBe(epic.id);
    await expect(e.as('planner').tasks.create({ title: 'c', parent: 'web-nope' })).rejects.toBeInstanceOf(NotFound);
  });

  it('returns the existing task for a key that exists, filing nothing new', async () => {
    const e = await openEngine();
    const first = await e.as('system').tasks.create({ title: 'gap', key: 'hash-1' });
    const again = await e.as('system').tasks.create({ title: 'gap, found again', key: 'hash-1' });
    expect(again).toEqual(first);
    expect(await e.rows(`select count(*)::int as n from taskgraph.tasks`)).toEqual([{ n: 1 }]);
    expect(await e.rows(`select count(*)::int as n from taskgraph.events where kind = 'task.created'`)).toEqual([{ n: 1 }]);
  });

  it('writes task.created with the actor, role and request id', async () => {
    const e = await openEngine();
    const task = await e.as('planner').tasks.create({ title: 't', tags: ['x'], spec: { checks: ['a'] } }, { requestId: 'r-1' });
    expect(task).toMatchObject({ tags: ['x'], spec: { checks: ['a'] } });
    expect(await e.rows(`select task_id, actor, actor_role, to_state, request_id from taskgraph.events where kind = 'task.created'`))
      .toEqual([{ task_id: task.id, actor: 'planner', actor_role: 'planner', to_state: 'proposed', request_id: 'r-1' }]);
  });

  it('refuses malformed input with InvalidRequest, and a role the permissions don\'t list', async () => {
    const e = await openEngine();
    await expect(e.as('planner').tasks.create({ title: '' })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.as('planner').tasks.create({ title: 't', priority: 7 })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.as('orchestrator').tasks.create({ title: 't' })).rejects.toBeInstanceOf(NotPermitted);
  });
});

describe('tasks.update', { timeout: 30_000 }, () => {
  it('changes fields and writes task.updated with the old and new values', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 'old', priority: 2 });
    const u = await e.as('planner').tasks.update(t.id, { title: 'new', priority: 1, tags: ['a'] });
    expect(u).toMatchObject({ id: t.id, title: 'new', priority: 1, tags: ['a'] });
    expect(u.updatedAt.getTime()).toBeGreaterThanOrEqual(t.updatedAt.getTime());
    const [ev] = await e.rows(`select payload from taskgraph.events where kind = 'task.updated'`);
    expect(ev.payload).toEqual({ changes: { title: { from: 'old', to: 'new' }, priority: { from: 2, to: 1 }, tags: { from: [], to: ['a'] } } });
  });

  it('writes nothing when nothing changes', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 'same' });
    await e.as('planner').tasks.update(t.id, { title: 'same' });
    expect(await e.rows(`select count(*)::int as n from taskgraph.events where kind = 'task.updated'`)).toEqual([{ n: 0 }]);
  });

  it('follows the per-state permission: a planner edits proposed tasks only', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 'open one' });
    await expect(e.as('planner').tasks.update(t.id, { title: 'x' })).rejects.toBeInstanceOf(NotPermitted);
    expect(await e.as('developer').tasks.update(t.id, { title: 'x' })).toMatchObject({ title: 'x' });
  });

  it('reparents keeping the id, and refuses a reparent into its own subtree', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const a = await p.tasks.create({ title: 'a', kind: 'container' });
    const b = await p.tasks.create({ title: 'b', kind: 'container' });
    const child = await p.tasks.create({ title: 'c', parent: a.id, kind: 'container' });
    expect(await p.tasks.update(child.id, { parent: b.id })).toMatchObject({ id: child.id, parentId: b.id });
    await expect(p.tasks.update(b.id, { parent: child.id })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(p.tasks.update(b.id, { parent: b.id })).rejects.toBeInstanceOf(InvalidRequest);
    expect(await p.tasks.update(child.id, { parent: null })).toMatchObject({ parentId: null });
  });

  it('refuses a kind change once a task has children', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const epic = await p.tasks.create({ title: 'epic', kind: 'container' });
    await p.tasks.create({ title: 'a', parent: epic.id });
    await expect(p.tasks.update(epic.id, { kind: 'work' })).rejects.toBeInstanceOf(InvalidRequest);
    const lone = await p.tasks.create({ title: 'lone', kind: 'container' });
    expect(await p.tasks.update(lone.id, { kind: 'work' })).toMatchObject({ kind: 'work' });
  });

  it('refuses a kind change once a task has attempts', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor)
      values (gen_random_uuid(), $1, $2, 'w', 'o')`, [e.tg.id, t.id]);
    await expect(e.as('planner').tasks.update(t.id, { kind: 'container' })).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('throws NotFound for an unknown task', async () => {
    const e = await openEngine();
    await expect(e.as('developer').tasks.update('web-nope', { title: 'x' })).rejects.toBeInstanceOf(NotFound);
  });
});

describe('tasks.delete', { timeout: 30_000 }, () => {
  it('removes a task still in create.state, with its edges, and writes task.deleted', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const a = await p.tasks.create({ title: 'a' });
    const b = await p.tasks.create({ title: 'b' });
    await p.deps.add(a.id, b.id);
    await p.tasks.delete(b.id);
    expect(await e.rows(`select id from taskgraph.tasks`)).toEqual([{ id: a.id }]);
    expect(await e.rows(`select count(*)::int as n from taskgraph.task_deps`)).toEqual([{ n: 0 }]);
    expect(await e.rows(`select task_id, payload from taskgraph.events where kind = 'task.deleted'`))
      .toEqual([{ task_id: b.id, payload: { title: 'b' } }]);
  });

  it('refuses a task past create.state, or one with children', async () => {
    const e = await openEngine();
    const open = await e.as('system').tasks.create({ title: 'open' });
    await expect(e.as('developer').tasks.delete(open.id)).rejects.toBeInstanceOf(NotPermitted); // permissions: proposed only
    const epic = await e.as('planner').tasks.create({ title: 'epic', kind: 'container' });
    await e.as('planner').tasks.create({ title: 'a', parent: epic.id });
    await expect(e.as('planner').tasks.delete(epic.id)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('writes dep.removed for each task that waited on the deleted one', async () => {
    const e = await openEngine();
    const p = e.as('planner');
    const a = await p.tasks.create({ title: 'a' });
    const b = await p.tasks.create({ title: 'b' });
    await p.deps.add(a.id, b.id);
    await p.tasks.delete(b.id);
    expect(await e.rows(`select task_id, payload from taskgraph.events where kind = 'dep.removed'`))
      .toEqual([{ task_id: a.id, payload: { dependsOnId: b.id, reason: 'deleted' } }]);
  });

  it('refuses a task that has left create.state, even where the permission allows the state', async () => {
    const l = testLifecycle();
    l.permissions['tasks.delete'] = { developer: true };
    const e = await openEngine(l);
    const open = await e.as('system').tasks.create({ title: 'open' });
    await expect(e.as('developer').tasks.delete(open.id)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('refuses a task with attempts', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor)
      values (gen_random_uuid(), $1, $2, 'w', 'o')`, [e.tg.id, t.id]);
    await expect(e.as('planner').tasks.delete(t.id)).rejects.toBeInstanceOf(InvalidRequest);
  });
});
