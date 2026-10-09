import { describe, it, expect, onTestFinished } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni, ShreniSchemaBehind } from './client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { exportShreniProject, importShreniProject, lastEventId } from './bundle';

// A project with Shreni's rows through export, purge and import (policy spec,
// "Shreni's tables"; engine spec, "Import, export and purge").

const ACTOR = { id: 'ann', role: 'developer' };

describe('Shreni project bundles', { timeout: PGLITE_TIMEOUT }, () => {
  it('round-trips a project with Shreni rows: a second export matches the first', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: ACTOR });
    const tg = shreni.tg.project(p.id);
    const orc = tg.as({ id: 'o', role: 'orchestrator' });
    await t.pglite.query(`insert into taskgraph.plans (project_id, id, title, meta) values ($1, 'web-plan-1', 'p', '{}')`, [p.id]);
    const task = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    const claim = (await orc.claim({ worker: 'w', leaseMs: 60_000 }))!;
    await orc.notes.add(task.id, 'Round 1: dispatching silpi');
    await shreni.transaction(async db => {
      await db.insertInto('shreni.projects').values({ project_id: p.id, mode: 'kshetra', repo_url: 'git@x:y.git' }).execute();
      await db.insertInto('shreni.intents').values({ project_id: p.id, plan_id: 'web-plan-1', statement: 'sign in' }).execute();
      await db.insertInto('shreni.acceptance_checks').values({
        project_id: p.id, task_id: task.id, given: 'g', when: 'w', then: 'th', mode: 'auto',
        locked_paths: ['a.test.ts'], locked_hashes: sql`'{"a.test.ts":"h"}'::jsonb` as never,
      }).execute();
      await db.insertInto('shreni.acceptance_checks').values({ project_id: p.id, plan_id: 'web-plan-1', given: 'g', when: 'w', then: 'th', mode: 'manual' }).execute();
      await sql`insert into shreni.attempt_evidence (attempt_id, pr_url, gates) values (${claim.attemptId}, 'https://x/pull/1', '{"acceptance":{"passed":true}}'::jsonb)`.execute(db);
      await db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'tests live under src' }).execute();
    });

    const first = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id)));
    expect(Object.fromEntries(Object.entries(first.shreni).map(([k, v]) => [k, (v as unknown[]).length])))
      .toEqual({ projects: 1, intents: 1, acceptance_checks: 2, attempt_evidence: 1, memories: 1 });
    const before = await lastEventId(shreni, p.id);
    expect(before).toMatch(/^\d+$/);

    await shreni.tg.projects.purge(p.id, { actor: ACTOR, confirmName: 'web' });
    expect((await t.pglite.query<any>(`select count(*)::int n from shreni.memories`)).rows[0].n).toBe(0);
    await importShreniProject(shreni, first, { actor: ACTOR });

    const second = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id)));
    second.engine.events = second.engine.events.filter((e: { kind: string }) => e.kind !== 'project.imported');
    expect(second).toEqual(first);
  });

  it('refuses a bundle that is not Shreni\'s', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await expect(importShreniProject(shreni, { format: 'taskgraph.project' } as never, { actor: ACTOR })).rejects.toThrow(/not a Shreni project bundle/);
  });

  it('reports the writer fence as ShreniSchemaBehind, writing nothing', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: ACTOR });
    await shreni.transaction(db => db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'c' }).execute());
    const b = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id)));
    await shreni.tg.projects.purge(p.id, { actor: ACTOR, confirmName: 'web' });
    await t.pglite.query(`update shreni.schema_meta set min_writer = 99`);
    await expect(importShreniProject(shreni, b, { actor: ACTOR })).rejects.toBeInstanceOf(ShreniSchemaBehind);
    expect((await t.pglite.query<any>(`select count(*)::int n from taskgraph.projects`)).rows[0].n).toBe(0);
  });
});
