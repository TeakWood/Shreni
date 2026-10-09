import { describe, it, expect, onTestFinished } from 'vitest';
import { sql } from 'kysely';
import { openEngine, type TestEngine } from './test/engine';
import { createMigratedTestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph } from './client';
import { BUILTIN_VALIDATORS, type PlanSnapshot, type Validator } from './validators';
import { NotFound, NotPermitted } from './errors';
import type { Task } from './types';

// Validation (engine spec, "Validation"): validators run as a dry run in
// plans.validate, and again inside approval.

async function plan(e: TestEngine, id = 'web-plan-1') {
  await e.t.pglite.query(`insert into taskgraph.plans (project_id, id, title) values ($1, $2, 'p')`, [e.tg.id, id]);
  return id;
}

const snapshotOf = (tasks: Partial<Task>[], deps: [string, string][] = [], links: [string, string, string][] = []): PlanSnapshot => ({
  plan: { projectId: 'p', id: 'pl', title: 't', meta: {}, approvedAt: null, approvedBy: null, discardedAt: null, discardedBy: null, createdAt: new Date() },
  tasks: tasks.map(t => ({ kind: 'work', state: 'proposed', parentId: null, ...t }) as Task),
  deps: deps.map(([taskId, dependsOnId]) => ({ taskId, dependsOnId })),
  links: links.map(([a, b, kind]) => ({ a, b, kind })),
});

/** Runs the built-ins on an in-memory snapshot; 'ext' is the one task outside it that exists. */
const run = async (s: PlanSnapshot) => {
  const out = [];
  for (const v of BUILTIN_VALIDATORS) {
    out.push(...await v.validate(s, { tx: undefined as never, config: undefined, lifecycle: testLifecycle(), exists: async ids => new Set(ids.filter(i => i === 'ext')) }));
  }
  return out;
};

describe('plans.validate', { timeout: 30_000 }, () => {
  it('returns an error naming an empty container, and writes nothing', async () => {
    const e = await openEngine();
    const id = await plan(e);
    const planner = e.as('planner');
    const epic = await planner.tasks.create({ title: 'epic', kind: 'container', plan: id });
    await planner.tasks.create({ title: 'work', plan: id });
    const before = await e.rows(`select (select count(*) from taskgraph.events)::int ev, (select max(updated_at) from taskgraph.tasks) up`);

    const report = await planner.plans.validate(id);
    expect(report).toMatchObject({ planId: id, ok: false });
    expect(report.findings).toEqual([
      { validator: 'engine.containers-have-children', severity: 'error', taskId: epic.id, message: expect.stringContaining(epic.id) },
    ]);
    expect(await e.rows(`select (select count(*) from taskgraph.events)::int ev, (select max(updated_at) from taskgraph.tasks) up`)).toEqual(before);
  });

  it('finds a plan task that has left the create state', async () => {
    const e = await openEngine();
    const id = await plan(e);
    const t = await e.as('planner').tasks.create({ title: 't', plan: id });
    await e.as('developer').move(t.id, 'approve');
    const report = await e.as('planner').plans.validate(id);
    expect(report.findings).toEqual([expect.objectContaining({ validator: 'engine.pre-approval', taskId: t.id, severity: 'error' })]);
  });

  it('is ok for a sound plan; refuses a role without plans.validate, and a missing plan', async () => {
    const e = await openEngine();
    const id = await plan(e);
    const epic = await e.as('planner').tasks.create({ title: 'epic', kind: 'container', plan: id });
    await e.as('planner').tasks.create({ title: 'child', plan: id, parent: epic.id });
    expect(await e.as('planner').plans.validate(id)).toEqual({ planId: id, ok: true, findings: [] });
    await expect(e.as('orchestrator').plans.validate(id)).rejects.toBeInstanceOf(NotPermitted);
    await expect(e.as('planner').plans.validate('web-plan-zz')).rejects.toBeInstanceOf(NotFound);
  });

  it('runs the caller\'s validators with the snapshot and their config; a throwing one is an error, and their writes are undone', async () => {
    const t = await createMigratedTestDb();
    const seen: PlanSnapshot[] = [];
    const sizing: Validator = {
      name: 'size', scope: 'plan',
      async validate(s, ctx) {
        seen.push(s);
        await sql`update taskgraph.tasks set title = 'changed by a validator'`.execute(ctx.tx);
        return s.tasks.length > (ctx.config as { max: number }).max
          ? [{ validator: 'size', severity: 'warning', message: `${s.tasks.length} tasks` }] : [];
      },
    };
    const broken: Validator = { name: 'broken', scope: 'task', async validate() { throw new Error('boom'); } };
    const client = await openTaskGraph({ db: t.db, lifecycle: testLifecycle(), validators: [sizing, broken], validatorConfig: { size: { max: 1 } } });
    onTestFinished(async () => { await client.close(); await t.close(); });
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg = client.project(p.id);
    await t.pglite.query(`insert into taskgraph.plans (project_id, id, title) values ($1, 'web-plan-1', 'p')`, [p.id]);
    const planner = tg.as({ id: 'pl', role: 'planner' });
    const a = await planner.tasks.create({ title: 'a', plan: 'web-plan-1' });
    const b = await planner.tasks.create({ title: 'b', plan: 'web-plan-1' });
    await tg.as({ id: 'd', role: 'developer' }).deps.add(b.id, a.id);
    const outside = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'outside' });
    await tg.as({ id: 'd', role: 'developer' }).links.add(a.id, outside.id, 'related');

    const report = await planner.plans.validate('web-plan-1');
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { validator: 'size', severity: 'warning', message: '2 tasks' },
      { validator: 'broken', severity: 'error', message: expect.stringContaining('boom') },
    ]);
    expect(seen[0].tasks.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(seen[0].deps).toEqual([{ taskId: b.id, dependsOnId: a.id }]);
    expect(seen[0].links).toEqual([{ a: a.id, b: outside.id, kind: 'related' }]);
    expect((await tg.tasks.get(a.id)).title).toBe('a');
  });
});

describe('the built-in validators', () => {

  it('find a cycle', async () => {
    const f = await run(snapshotOf([{ id: 'a' }, { id: 'b' }], [['a', 'b'], ['b', 'a']]));
    expect(f).toEqual([expect.objectContaining({ validator: 'engine.no-cycles', severity: 'error' })]);
  });

  it('find references to tasks that exist neither in the plan nor the project', async () => {
    const f = await run(snapshotOf([{ id: 'a' }, { id: 'b', parentId: 'gone' }], [['a', 'ext'], ['a', 'nope']], [['a', 'void', 'related']]));
    expect(f.filter(x => x.validator === 'engine.no-missing-refs').map(x => x.message).join(' ')).toMatch(/nope.*void.*gone|nope[\s\S]*void[\s\S]*gone/);
    expect(f.filter(x => x.validator === 'engine.no-missing-refs')).toHaveLength(3);
  });
});

describe('review follow-ups (T3.1)', { timeout: 30_000 }, () => {
  it('a container whose only child sits outside the plan has a child; a cycle through an outside task is named', async () => {
    const e = await openEngine();
    const id = await plan(e);
    const planner = e.as('planner');
    const epic = await planner.tasks.create({ title: 'epic', kind: 'container', plan: id });
    await e.as('system').tasks.create({ title: 'outside child', parent: epic.id });
    expect((await planner.plans.validate(id)).findings).toEqual([]);

    const f = await run(snapshotOf([{ id: 'a' }], [['a', 'ext'], ['ext', 'a']]));
    expect(f).toEqual([expect.objectContaining({ validator: 'engine.no-cycles', taskId: 'a', message: expect.stringMatching(/a.*ext.*a/) })]);
  });

  it('after a validator fails in SQL, the next still runs on a sound transaction; custom validators see only tx and config', async () => {
    const t = await createMigratedTestDb();
    let sawCtx: object | undefined;
    const bad: Validator = { name: 'bad', scope: 'plan', async validate(_s, ctx) { await sql`select * from no_such_table`.execute(ctx.tx); return []; } };
    const good: Validator = {
      name: 'good', scope: 'plan',
      async validate(s, ctx) {
        sawCtx = ctx;
        const r = await sql<{ n: number }>`select count(*)::int n from taskgraph.tasks`.execute(ctx.tx);
        return [{ validator: 'good', severity: 'warning', message: `${r.rows[0].n} tasks, config ${JSON.stringify(ctx.config)}` }];
      },
    };
    const client = await openTaskGraph({
      db: t.db, lifecycle: testLifecycle(), validators: [bad, good],
      validatorConfig: (projectId, name) => (name === 'good' ? { project: projectId.slice(0, 4) } : undefined),
    });
    onTestFinished(async () => { await client.close(); await t.close(); });
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    await t.pglite.query(`insert into taskgraph.plans (project_id, id, title) values ($1, 'web-plan-1', 'p')`, [p.id]);
    await client.project(p.id).as({ id: 'pl', role: 'planner' }).tasks.create({ title: 'a', plan: 'web-plan-1' });
    const report = await client.project(p.id).as({ id: 'pl', role: 'planner' }).plans.validate('web-plan-1');
    expect(report.findings).toEqual([
      { validator: 'bad', severity: 'error', message: expect.stringContaining('no_such_table') },
      { validator: 'good', severity: 'warning', message: `1 tasks, config {"project":"${p.id.slice(0, 4)}"}` },
    ]);
    expect(Object.keys(sawCtx!).sort()).toEqual(['config', 'tx']);
  });

  it('the pre-approval check is task-scoped; the graph checks are plan-scoped', () => {
    expect(Object.fromEntries(BUILTIN_VALIDATORS.map(v => [v.name, v.scope]))).toEqual({
      'engine.no-cycles': 'plan', 'engine.no-missing-refs': 'plan', 'engine.containers-have-children': 'plan', 'engine.pre-approval': 'task',
    });
  });
});
