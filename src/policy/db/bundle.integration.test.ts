import { describe, it, expect, onTestFinished } from 'vitest';
import postgres from 'postgres';
import { freshDatabase } from '../../taskgraph/test/postgres';
import { openShreni } from './client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { exportShreniProject, importShreniProject, lastEventId } from './bundle';
import { engineReads } from '../sthapathi/reads';

// Shreni's bundle and reads on real Postgres, through postgres.js: the row
// copies (jsonb_populate_recordset), the array parameters and the event order.

const ACTOR = { id: 'ann', role: 'developer' };

describe('Shreni project bundles on real Postgres', () => {
  it('round-trip a project with Shreni rows, and read back notes oldest first', async () => {
    const url = await freshDatabase();
    const sql = postgres(url, { max: 4, onnotice: () => {} });
    const shreni = await openShreni({ sql, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await sql.end({ timeout: 1 }); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: ACTOR });
    const tg = shreni.tg.project(p.id);
    const orc = tg.as({ id: 'o', role: 'orchestrator' });
    const a = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    for (let i = 1; i <= 11; i++) await orc.notes.add(a.id, `Round ${i}: note`);
    await shreni.transaction(async db => {
      await db.insertInto('shreni.projects').values({ project_id: p.id, mode: 'kshetra' }).execute();
      await db.insertInto('shreni.acceptance_checks').values({
        project_id: p.id, task_id: a.id, given: 'g', when: 'w', then: 'th', mode: 'auto', locked_paths: ['x.test.ts'],
      }).execute();
      await db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'c' }).execute();
    });
    const [row] = JSON.parse(await engineReads(shreni, tg).show(a.id));
    expect(row.notes.split('\n').map((l: string) => Number(l.match(/\d+/)![0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(row.acceptance_criteria).toBe('- Given g, when w, then th');
    expect(await lastEventId(shreni, p.id)).toMatch(/^\d+$/);

    const first = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id)));
    await shreni.tg.projects.purge(p.id, { actor: ACTOR, confirmName: 'web' });
    await importShreniProject(shreni, first, { actor: ACTOR });
    const second = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id)));
    second.engine.events = second.engine.events.filter((e: { kind: string }) => e.kind !== 'project.imported');
    expect(second).toEqual(first);
  });
});
