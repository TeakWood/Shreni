import { describe, it, expect, onTestFinished } from 'vitest';
import { openEngine } from './test/engine';
import { createMigratedTestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph } from './client';
import type { Validator } from './validators';
import { InvalidRequest, MoveRefused, NotPermitted, ValidationError } from './errors';

// Plans, approval and discard (engine spec, "Validation" and "Approval").

const via = { via: 'cli' };

describe('plans.create', { timeout: 30_000 }, () => {
  it('creates a plan with a plan id and a plan.created event', async () => {
    const e = await openEngine();
    const p = await e.as('planner').plans.create({ title: 'login', meta: { why: 'users' } });
    expect(p).toMatchObject({ title: 'login', meta: { why: 'users' }, approvedAt: null, discardedAt: null });
    expect(p.id).toMatch(/^web-plan-[0-9a-z]{3,}$/);
    expect(await e.rows(`select kind, plan_id, actor from taskgraph.events where kind = 'plan.created'`))
      .toEqual([{ kind: 'plan.created', plan_id: p.id, actor: 'planner' }]);
    await expect(e.as('orchestrator').plans.create({ title: 'x' })).rejects.toBeInstanceOf(NotPermitted);
  });
});

describe('plans.approve', { timeout: 30_000 }, () => {
  it('refuses a plan with an error finding, and opens nothing', async () => {
    const e = await openEngine();
    const planner = e.as('planner');
    const p = await planner.plans.create({ title: 'p' });
    const epic = await planner.tasks.create({ title: 'epic', kind: 'container', plan: p.id });
    await planner.tasks.create({ title: 'work', plan: p.id });
    const err = await e.as('developer').plans.approve(p.id, via).catch(x => x);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.findings).toEqual([expect.objectContaining({ taskId: epic.id, validator: 'engine.containers-have-children' })]);
    expect(await e.rows(`select distinct state from taskgraph.tasks`)).toEqual([{ state: 'proposed' }]);
    expect((await e.tg.plans.get(p.id)).approvedAt).toBeNull();
  });

  it('opens every proposed task of a valid plan in one transaction, and records who approved it and how', async () => {
    const e = await openEngine();
    const planner = e.as('planner');
    const p = await planner.plans.create({ title: 'p' });
    const epic = await planner.tasks.create({ title: 'epic', kind: 'container', plan: p.id });
    const a = await planner.tasks.create({ title: 'a', plan: p.id, parent: epic.id });
    const b = await planner.tasks.create({ title: 'b', plan: p.id, parent: epic.id });
    await e.as('developer').deps.add(b.id, a.id);

    const approved = await e.as('developer').plans.approve(p.id, via);
    expect(approved).toMatchObject({ id: p.id, approvedBy: 'developer', approvedAt: expect.any(Date), findings: [] });
    expect(await e.rows(`select distinct state from taskgraph.tasks`)).toEqual([{ state: 'open' }]);
    expect(await e.rows(`select count(distinct txid)::int n from (select xmin::text as txid from taskgraph.tasks) x`)).toEqual([{ n: 1 }]);
    expect(await e.rows(`select kind, plan_id, payload->>'via' as via from taskgraph.events where kind = 'plan.approved'`))
      .toEqual([{ kind: 'plan.approved', plan_id: p.id, via: 'cli' }]);
    expect(await e.rows(`select count(*)::int n from taskgraph.events where kind = 'move:approve' and plan_id = $1`, [p.id])).toEqual([{ n: 3 }]);
    expect((await e.tg.ready()).map(t => t.id)).toEqual([a.id]);

    await expect(e.as('developer').plans.approve(p.id, via)).rejects.toBeInstanceOf(InvalidRequest);
    await expect(planner.tasks.create({ title: 'late', plan: p.id })).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('is refused for a role the approve move doesn\'t list', async () => {
    const e = await openEngine();
    const p = await e.as('planner').plans.create({ title: 'p' });
    await e.as('planner').tasks.create({ title: 'a', plan: p.id });
    await expect(e.as('planner').plans.approve(p.id, via)).rejects.toBeInstanceOf(NotPermitted);
  });

  it('returns warnings with the result', async () => {
    const t = await createMigratedTestDb();
    const warn: Validator = { name: 'w', scope: 'plan', async validate() { return [{ validator: 'w', severity: 'warning', message: 'hm' }]; } };
    const client = await openTaskGraph({ db: t.db, lifecycle: testLifecycle(), validators: [warn] });
    onTestFinished(async () => { await client.close(); await t.close(); });
    const proj = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg = client.project(proj.id);
    const p = await tg.as({ id: 'pl', role: 'planner' }).plans.create({ title: 'p' });
    await tg.as({ id: 'pl', role: 'planner' }).tasks.create({ title: 'a', plan: p.id });
    expect((await tg.as({ id: 'd', role: 'developer' }).plans.approve(p.id, via)).findings)
      .toEqual([{ validator: 'w', severity: 'warning', message: 'hm' }]);
  });
});

describe('plans.discard', { timeout: 30_000 }, () => {
  it('cancels every proposed task, children and waiting tasks first, and records the discard', async () => {
    const e = await openEngine();
    const planner = e.as('planner');
    const p = await planner.plans.create({ title: 'p' });
    const epic = await planner.tasks.create({ title: 'epic', kind: 'container', plan: p.id });
    const a = await planner.tasks.create({ title: 'a', plan: p.id, parent: epic.id });
    const b = await planner.tasks.create({ title: 'b', plan: p.id, parent: epic.id });
    await e.as('developer').deps.add(b.id, a.id);

    const discarded = await e.as('developer').plans.discard(p.id, via);
    expect(discarded).toMatchObject({ discardedBy: 'developer', discardedAt: expect.any(Date) });
    expect(await e.rows(`select distinct state from taskgraph.tasks`)).toEqual([{ state: 'cancelled' }]);
    expect((await e.rows(`select task_id from taskgraph.events where kind = 'move:cancel' order by id`)).map(r => r.task_id))
      .toEqual([b.id, a.id, epic.id]);
    expect(await e.rows(`select payload->>'via' as via from taskgraph.events where kind = 'plan.discarded'`)).toEqual([{ via: 'cli' }]);
    await expect(e.as('developer').plans.approve(p.id, via)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('is refused, naming it, when a task outside the plan waits on one inside', async () => {
    const e = await openEngine();
    const p = await e.as('planner').plans.create({ title: 'p' });
    const inside = await e.as('planner').tasks.create({ title: 'inside', plan: p.id });
    const outside = await e.as('system').tasks.create({ title: 'outside' });
    await e.as('developer').deps.add(outside.id, inside.id);
    const err = await e.as('developer').plans.discard(p.id, via).catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    expect(err).toMatchObject({ reason: 'DependentsLive', waiting: [outside.id] });
    expect(await e.rows(`select state from taskgraph.tasks where id = $1`, [inside.id])).toEqual([{ state: 'proposed' }]);
  });

  it('writes children.settled for a container outside the plan that it settles', async () => {
    const e = await openEngine();
    const epic = await e.as('system').tasks.create({ title: 'epic', kind: 'container' });
    const p = await e.as('planner').plans.create({ title: 'p' });
    await e.as('planner').tasks.create({ title: 'a', plan: p.id, parent: epic.id });
    await e.as('developer').plans.discard(p.id, via);
    expect(await e.rows(`select task_id from taskgraph.events where kind = 'children.settled'`)).toEqual([{ task_id: epic.id }]);
  });
});

describe('tasks.approve', { timeout: 30_000 }, () => {
  it('opens a lone task after the task-scope validators; a task in a plan is approved with its plan', async () => {
    const t = await createMigratedTestDb();
    let ran: string[] = [];
    const planScoped: Validator = { name: 'plan-only', scope: 'plan', async validate() { ran.push('plan'); return []; } };
    const taskScoped: Validator = {
      name: 'needs-desc', scope: 'task',
      async validate(s) {
        ran.push('task');
        return s.tasks.filter(x => !x.description).map(x => ({ validator: 'needs-desc', severity: 'error' as const, taskId: x.id, message: 'no description' }));
      },
    };
    const client = await openTaskGraph({ db: t.db, lifecycle: testLifecycle(), validators: [planScoped, taskScoped] });
    onTestFinished(async () => { await client.close(); await t.close(); });
    const proj = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg = client.project(proj.id);
    const dev = tg.as({ id: 'd', role: 'developer' });
    const bare = await dev.tasks.create({ title: 'bare' });
    await expect(dev.tasks.approve(bare.id, via)).rejects.toBeInstanceOf(ValidationError);
    expect(ran).toEqual(['task']);
    ran = [];
    const ok = await dev.tasks.create({ title: 'ok', description: 'why' });
    expect(await dev.tasks.approve(ok.id, via)).toMatchObject({ state: 'open' });
    expect(await t.pglite.query(`select payload->>'via' as via from taskgraph.events where kind = 'move:approve'`).then(r => r.rows)).toEqual([{ via: 'cli' }]);

    const p = await tg.as({ id: 'pl', role: 'planner' }).plans.create({ title: 'p' });
    const inPlan = await tg.as({ id: 'pl', role: 'planner' }).tasks.create({ title: 'x', description: 'y', plan: p.id });
    await expect(dev.tasks.approve(inPlan.id, via)).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe('request ids on plan writes', { timeout: 30_000 }, () => {
  it('create, approve and discard return their first result on a retry', async () => {
    const e = await openEngine();
    const p = await e.as('planner').plans.create({ title: 'p' }, { requestId: 'c' });
    expect(await e.as('planner').plans.create({ title: 'p' }, { requestId: 'c' })).toEqual(p);
    await e.as('planner').tasks.create({ title: 'a', plan: p.id });
    const ok = await e.as('developer').plans.approve(p.id, { via: 'cli', requestId: 'a' });
    expect(await e.as('developer').plans.approve(p.id, { via: 'cli', requestId: 'a' })).toMatchObject({ id: p.id, approvedBy: 'developer' });
    expect(ok.id).toBe(p.id);
  });
});

describe('review follow-ups (T3.2)', { timeout: 30_000 }, () => {
  it('tasks.approve and discard return their first result on a retry with the same request id', async () => {
    const e = await openEngine();
    const t = await e.as('developer').tasks.create({ title: 't' });
    const first = await e.as('developer').tasks.approve(t.id, { via: 'cli', requestId: 'ta' });
    expect(await e.as('developer').tasks.approve(t.id, { via: 'cli', requestId: 'ta' })).toEqual(first);

    const p = await e.as('planner').plans.create({ title: 'p' });
    await e.as('planner').tasks.create({ title: 'a', plan: p.id });
    const d = await e.as('developer').plans.discard(p.id, { via: 'cli', requestId: 'pd' });
    expect(await e.as('developer').plans.discard(p.id, { via: 'cli', requestId: 'pd' })).toEqual(d);
  });

  it('a discard is refused with ChildrenLive when a live task outside the plan sits under a plan container', async () => {
    const e = await openEngine();
    const p = await e.as('planner').plans.create({ title: 'p' });
    const epic = await e.as('planner').tasks.create({ title: 'epic', kind: 'container', plan: p.id });
    const outside = await e.as('system').tasks.create({ title: 'outside child', parent: epic.id });
    const err = await e.as('developer').plans.discard(p.id, via).catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    expect(err).toMatchObject({ reason: 'ChildrenLive', children: [outside.id] });
  });

  it('moves into a terminal state re-check live children under the lock', async () => {
    const e = await openEngine();
    const p = await e.as('planner').plans.create({ title: 'p' });
    const epic = await e.as('planner').tasks.create({ title: 'epic', kind: 'container', plan: p.id });
    // a live child that the discard's first look can't see: parked, in the plan, so it isn't cancelled
    const child = await e.as('planner').tasks.create({ title: 'parked child', plan: p.id, parent: epic.id });
    await e.as('developer').move(child.id, 'park');
    const err = await e.as('developer').plans.discard(p.id, via).catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    expect(err).toMatchObject({ reason: 'ChildrenLive' });
    expect(await e.rows(`select state from taskgraph.tasks where id = $1`, [epic.id])).toEqual([{ state: 'proposed' }]);
  });
});
