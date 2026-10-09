import { describe, it, expect, onTestFinished } from 'vitest';
import { sql } from 'kysely';
import { openEngine, type TestEngine } from './test/engine';
import { createWireTestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph } from './client';
import { CycleError, InvalidRequest, VersionMismatch } from './errors';
import type { ProjectBundle } from './bundle';

// Import, export and purge (engine spec, "Import, export and purge").

const ACTOR = { id: 'ann', role: 'developer' };

/** A project with something of every kind of row in it. */
async function populate(e: TestEngine) {
  const sys = e.as('system');
  const dev = e.as('developer');
  await e.t.pglite.query(`insert into taskgraph.plans (project_id, id, title, meta) values ($1, 'web-plan-1', 'p', '{"why":"x"}')`, [e.tg.id]);
  const planned = await e.as('planner').tasks.create({ title: 'planned', plan: 'web-plan-1', spec: { acceptance: ['a'] } });
  const epic = await sys.tasks.create({ title: 'epic', kind: 'container', tags: ['big'] });
  const a = await sys.tasks.create({ title: 'a', parent: epic.id, description: 'first child' });
  const b = await sys.tasks.create({ title: 'b', parent: epic.id, priority: 0 });
  await dev.deps.add(b.id, a.id);
  await dev.links.add(a.id, planned.id, 'related');
  await dev.notes.add(a.id, 'a note', { requestId: 'req-1' });
  await dev.tasks.update(b.id, { holdUntil: new Date('2030-01-01T00:00:00Z') });
  await dev.move(planned.id, 'approve');
  // a live lease, as claim writes it
  await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor)
                          values ('00000000-0000-0000-0000-0000000000c1', $1, $2, 'w/1', 'orc')`, [e.tg.id, a.id]);
  await e.t.pglite.query(`update taskgraph.tasks set state = 'claimed', boosted = true,
                          lease_attempt_id = '00000000-0000-0000-0000-0000000000c1', lease_expires_at = '2030-01-01Z' where id = $1`, [a.id]);
  return { planned, epic, a, b };
}

/** The bundle without the import's own trailing event. */
const withoutImportEvent = (b: ProjectBundle): ProjectBundle =>
  ({ ...b, events: b.events.filter(x => x.kind !== 'project.imported') });

describe('export, purge and import', { timeout: 30_000 }, () => {
  it('round-trips: a second export matches the first', async () => {
    const e = await openEngine();
    await populate(e);
    const first = await e.client.projects.export(e.tg.id);
    expect(first.tasks).toHaveLength(4);
    expect(first.events.length).toBeGreaterThan(5);

    const json = JSON.parse(JSON.stringify(first)) as ProjectBundle;
    await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    const report = await e.client.projects.import(json, { actor: ACTOR });
    expect(report.project.id).toBe(e.tg.id);
    expect(report.counts).toMatchObject({ tasks: 4, deps: 1, links: 1, plans: 1, attempts: 1 });

    const second = await e.client.projects.export(e.tg.id);
    expect(withoutImportEvent(second)).toEqual(first);
    expect(second.events.at(-1)).toMatchObject({ kind: 'project.imported', actor: 'ann' });
  });

  it('runs the export callback inside the export\'s snapshot', async () => {
    // Over the postgres.js dialect, which sets the isolation level (PGlite's Kysely dialect ignores it).
    const w = await createWireTestDb();
    const client = await openTaskGraph({ sql: w.sql, lifecycle: testLifecycle() });
    onTestFinished(async () => { await client.close(); await w.close(); });
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ACTOR });
    let isolation = '';
    await client.projects.export(p.id, async ({ db }) => {
      const r = await sql<{ i: string }>`select current_setting('transaction_isolation') as i`.execute(db);
      isolation = r.rows[0].i;
    });
    expect(isolation).toBe('repeatable read');
  });

  it('writes nothing when the callback throws', async () => {
    const e = await openEngine();
    await populate(e);
    const bundle = await e.client.projects.export(e.tg.id);
    await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    const before = await e.rows(`select (select count(*) from taskgraph.tasks)::int t, (select count(*) from taskgraph.events)::int ev,
                                        (select count(*) from taskgraph.projects)::int p`);
    let seen = 0;
    await expect(e.client.projects.import(bundle, { actor: ACTOR }, async ({ db, project }) => {
      const r = await db.selectFrom('taskgraph.tasks').select('id').where('project_id', '=', project.id).execute();
      seen = r.length;
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(seen).toBe(4);
    expect(await e.rows(`select (select count(*) from taskgraph.tasks)::int t, (select count(*) from taskgraph.events)::int ev,
                                (select count(*) from taskgraph.projects)::int p`)).toEqual(before);
  });

  it('imports under a new name and prefix, as a new project when the bundle has no id', async () => {
    const e = await openEngine();
    await populate(e);
    const bundle = await e.client.projects.export(e.tg.id);
    const { id: _id, ...project } = bundle.project;
    const report = await e.client.projects.import(
      { ...bundle, project, attempts: [], tasks: bundle.tasks.map(t => ({ ...t, state: t.state === 'claimed' ? 'open' : t.state, leaseAttemptId: null, leaseExpiresAt: null })) },
      { actor: ACTOR, name: 'copy' });
    expect(report.project.id).not.toBe(e.tg.id);
    expect(report.project).toMatchObject({ name: 'copy', idPrefix: 'web' });
    expect(await e.client.project(report.project.id).tasks.count()).toBe(4);
  });

  it('sets each parent\'s child counter past its highest imported child', async () => {
    const e = await openEngine();
    const bundle = await e.client.projects.export(e.tg.id);
    await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    const at = new Date('2026-01-01Z');
    const task = (id: string, parentId: string | null, kind: 'work' | 'container' = 'work') => ({
      id, key: null, planId: null, parentId, kind, category: null, title: id, description: null, priority: 2, state: 'open',
      origin: 'imported' as const, spec: {}, tags: [], boosted: false, holdUntil: null, nextChild: 1,
      leaseAttemptId: null, leaseExpiresAt: null, createdAt: at, updatedAt: at, closedAt: null,
    });
    await e.client.projects.import({ ...bundle, tasks: [task('web-e', null, 'container'), task('web-e.5', 'web-e')] }, { actor: ACTOR });
    const child = await e.as('system').tasks.create({ title: 'next', parent: 'web-e' });
    expect(child.id).toBe('web-e.6');
    expect((await e.tg.tasks.get('web-e.5')).origin).toBe('imported');
  });
});

describe('import refuses a bad bundle', { timeout: 30_000 }, () => {
  async function setup() {
    const e = await openEngine();
    const { a, b } = await populate(e);
    const bundle = await e.client.projects.export(e.tg.id);
    await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    return { e, bundle, a, b };
  }

  it('with a dependency cycle', async () => {
    const { e, bundle, a, b } = await setup();
    await expect(e.client.projects.import({ ...bundle, deps: [...bundle.deps, { taskId: a.id, dependsOnId: b.id }] }, { actor: ACTOR }))
      .rejects.toBeInstanceOf(CycleError);
  });

  it('with a reference to a missing task, a parent cycle, or an undeclared state', async () => {
    const { e, bundle, a, b } = await setup();
    const imp = (x: ProjectBundle) => e.client.projects.import(x, { actor: ACTOR });
    await expect(imp({ ...bundle, links: [{ a: a.id, b: 'web-zzz', kind: 'related' }] })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(imp({ ...bundle, tasks: bundle.tasks.map(t => t.id === a.id ? { ...t, parentId: b.id } : t.id === b.id ? { ...t, parentId: a.id } : t) }))
      .rejects.toBeInstanceOf(InvalidRequest);
    await expect(imp({ ...bundle, tasks: bundle.tasks.map(t => t.id === b.id ? { ...t, state: 'zzz' } : t) })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(imp({ ...bundle, format: 'beads' } as any)).rejects.toBeInstanceOf(InvalidRequest);
    expect(await e.rows(`select count(*)::int n from taskgraph.projects`)).toEqual([{ n: 0 }]);
  });

  it('on another lifecycle version', async () => {
    const { e, bundle } = await setup();
    await expect(e.client.projects.import({ ...bundle, project: { ...bundle.project, lifecycleVersion: 2 } }, { actor: ACTOR }))
      .rejects.toBeInstanceOf(VersionMismatch);
  });

  it('over a project that already exists', async () => {
    const e = await openEngine();
    const bundle = await e.client.projects.export(e.tg.id);
    await expect(e.client.projects.import(bundle, { actor: ACTOR })).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe('purge', { timeout: 30_000 }, () => {
  it('needs the project\'s name typed back, removes every row of it and nothing else, and records the purge', async () => {
    const e = await openEngine();
    await populate(e);
    const other = await e.client.projects.create({ name: 'api', idPrefix: 'api', actor: ACTOR });
    await e.client.project(other.id).as({ id: 's', role: 'system' }).tasks.create({ title: 'stays' });

    await expect(e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'wbe' })).rejects.toBeInstanceOf(InvalidRequest);
    const report = await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    expect(report.counts).toMatchObject({ tasks: 4, deps: 1, links: 1, plans: 1, attempts: 1, projects: 1 });

    for (const table of ['tasks', 'task_deps', 'task_links', 'attempts', 'events', 'plans']) {
      expect(await e.rows(`select count(*)::int n from taskgraph.${table} where project_id = $1`, [e.tg.id])).toEqual([{ n: 0 }]);
    }
    expect(await e.client.project(other.id).tasks.count()).toBe(1);
    expect(await e.rows(`select name, actor, counts->>'tasks' as tasks from taskgraph.purges where project_id = $1`, [e.tg.id]))
      .toEqual([{ name: 'web', actor: 'ann', tasks: '4' }]);
  });
});

describe('over postgres.js', { timeout: 30_000 }, () => {
  it('round-trips through the production driver', async () => {
    const w = await createWireTestDb();
    const client = await openTaskGraph({ sql: w.sql, lifecycle: testLifecycle() });
    onTestFinished(async () => { await client.close(); await w.close(); });
    await client.migrate();
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: ACTOR });
    const as = client.project(p.id).as({ id: 's', role: 'system' });
    const epic = await as.tasks.create({ title: 'epic', kind: 'container', tags: ['x'], spec: { a: [1] } });
    const a = await as.tasks.create({ title: 'a', parent: epic.id, holdUntil: new Date('2030-01-01Z') });
    await client.project(p.id).as(ACTOR).notes.add(a.id, 'n', { requestId: 'r' });

    const first = await client.projects.export(p.id);
    const report = await client.projects.purge(p.id, { actor: ACTOR, confirmName: 'web' });
    expect(report.counts).toMatchObject({ tasks: 2, projects: 1 });
    await client.projects.import(JSON.parse(JSON.stringify(first)), { actor: ACTOR });
    expect(withoutImportEvent(await client.projects.export(p.id))).toEqual(first);
  });
});

describe('review follow-ups', { timeout: 30_000 }, () => {
  async function exported() {
    const e = await openEngine();
    const rows = await populate(e);
    const bundle = await e.client.projects.export(e.tg.id);
    await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    return { e, bundle, ...rows, imp: (x: ProjectBundle) => e.client.projects.import(x, { actor: ACTOR }) };
  }
  const refused = async (p: Promise<unknown>, pattern: RegExp) => {
    const err = await p.catch(x => x);
    expect(err).toBeInstanceOf(InvalidRequest);
    expect(err.message).toMatch(pattern);
  };

  it('refuses a leased task without its open attempt, or a lease outside the leased state', async () => {
    const { bundle, a, b, imp } = await exported();
    await refused(imp({ ...bundle, tasks: bundle.tasks.map(t => t.id === a.id ? { ...t, leaseAttemptId: null, leaseExpiresAt: null } : t) }), /lease/);
    await refused(imp({ ...bundle, attempts: bundle.attempts.map(x => ({ ...x, endedAt: new Date() })) }), /attempt/);
    await refused(imp({ ...bundle, tasks: bundle.tasks.map(t => t.id === b.id ? { ...t, state: 'claimed' } : t) }), /lease/);
  });

  it('refuses live children under a terminal container, and live tasks waiting on cancelled work', async () => {
    const { bundle, epic, a, imp } = await exported();
    await refused(imp({ ...bundle, tasks: bundle.tasks.map(t => t.id === epic.id ? { ...t, state: 'done' } : t) }), /live child/);
    await refused(imp({ ...bundle, tasks: bundle.tasks.map(t => t.id === a.id ? { ...t, state: 'cancelled', leaseAttemptId: null, leaseExpiresAt: null } : t),
      attempts: bundle.attempts.map(x => ({ ...x, endedAt: new Date(), outcome: 'cancel' })) }), /waits on/);
  });

  it('refuses a dependency between a task and a container above it', async () => {
    const { bundle, epic, imp } = await exported();
    const child = bundle.tasks.find(t => t.parentId === epic.id)!;
    const err = await imp({ ...bundle, deps: [...bundle.deps, { taskId: epic.id, dependsOnId: child.id }] }).catch(x => x);
    expect(err).toBeInstanceOf(CycleError);
    expect(err.message).toMatch(/one contains the other/);
  });

  it('refuses duplicates inside the bundle, naming them', async () => {
    const { bundle, imp } = await exported();
    await refused(imp({ ...bundle, deps: [...bundle.deps, ...bundle.deps] }), /repeats/);
    await refused(imp({ ...bundle, links: [...bundle.links, ...bundle.links] }), /repeats/);
    await refused(imp({ ...bundle, plans: [...bundle.plans, ...bundle.plans] }), /repeats/);
    await refused(imp({ ...bundle, events: [...bundle.events, ...bundle.events.filter(x => x.requestId)] }), /repeats/);
    await refused(imp({ ...bundle, events: [{ ...bundle.events[0], attemptId: 'nope' }] }), /attemptId/);
  });

  it('passes the callback\'s own errors through untouched', async () => {
    const { bundle, e } = await exported();
    const mine = Object.assign(new Error('mine'), { code: '23505' });
    await expect(e.client.projects.import(bundle, { actor: ACTOR }, async () => { throw mine; })).rejects.toBe(mine);
  });

  it('sets the child counter past every <parent>.<n> id, wherever that task now sits', async () => {
    const e = await openEngine();
    const bundle = await e.client.projects.export(e.tg.id);
    await e.client.projects.purge(e.tg.id, { actor: ACTOR, confirmName: 'web' });
    const at = new Date('2026-01-01Z');
    const task = (id: string, parentId: string | null, kind: 'work' | 'container' = 'work') => ({
      id, key: null, planId: null, parentId, kind, category: null, title: id, description: null, priority: 2, state: 'open',
      origin: 'imported' as const, spec: {}, tags: [], boosted: false, holdUntil: null, nextChild: 1,
      leaseAttemptId: null, leaseExpiresAt: null, createdAt: at, updatedAt: at, closedAt: null,
    });
    await e.client.projects.import({ ...bundle, tasks: [
      task('web-e', null, 'container'), task('web-f', null, 'container'), task('web-e.1', 'web-e'), task('web-e.3', 'web-f'),
    ] }, { actor: ACTOR });
    expect((await e.as('system').tasks.create({ title: 'n', parent: 'web-e' })).id).toBe('web-e.4');
  });
});
