import { describe, it, expect, onTestFinished } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { engineTaskStore } from './task-store';
import { registerEngineStore, unregisterEngineStore, trackerFor } from '../../sthapathi/task-store';
import { ensureHealthBead } from '../../sthapathi/health';
import { fileCoverageGaps } from '../../sthapathi/parikshaka-dispatch';
import { parseAcceptanceCriteria } from '../../sthapathi/task-json';
import type { KshetraConfig } from '../../kshetra/config.js';
import type { Claim } from '../../taskgraph';
import type { ParikshakaOutput } from '../../sthapathi/types';

// Dispatch, health and Parikshaka on the engine (policy spec, "Approval:
// humans only", Where filed tasks land).

const kshetra = { id: 'web-filing' } as KshetraConfig;

async function setup() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { unregisterEngineStore(kshetra.id); await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  const as = tg.as({ id: 'sthapathi', role: 'orchestrator' });
  const claims = new Map<string, Claim>();
  const store = engineTaskStore({
    shreni, tg, as, claimFor: id => claims.get(id),
    systemActor: tg.as({ id: 'sthapathi', role: 'system' }), agentActor: tg.as({ id: 'parikshaka', role: 'agent' }),
  });
  registerEngineStore(kshetra.id, store);
  const rows = async (q: string, params: unknown[] = []) => (await t.pglite.query<any>(q, params)).rows;
  return { shreni, tg, as, claims, store, rows, sys: tg.as({ id: 's', role: 'system' }) };
}

const gap = (feature: string, description: string) => ({ feature, description, priority: 2 });

describe('the health gate on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('files its repair task once for a red main, open (filed by system), and again only once that one is done', async () => {
    const { rows, tg } = await setup();
    expect(await ensureHealthBead(kshetra, 3)).toBe(true);
    expect(await ensureHealthBead(kshetra, 4)).toBe(false);
    expect(await rows(`select state, origin, title from taskgraph.tasks`)).toEqual([
      { state: 'open', origin: 'system', title: '[shreni-health] Restore green test suite (3 failing)' },
    ]);
    const [task] = await tg.tasks.list({ tags: ['shreni-health'] });
    const c = (await tg.as({ id: 'o', role: 'orchestrator' }).claim({ worker: 'w', leaseMs: 60_000 }))!;
    await tg.as({ id: 'o', role: 'orchestrator' }).moveClaimed(c, 'finish');
    expect((await tg.tasks.get(task.id)).state).toBe('done');
    expect(await ensureHealthBead(kshetra, 1)).toBe(true);
    expect(await rows(`select count(*)::int n from taskgraph.tasks where state = 'open'`)).toEqual([{ n: 1 }]);
  });
});

describe('Parikshaka\'s gaps on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('a gap whose epic has closed is proposed, standalone, and linked to its task; filed once', async () => {
    const { tg, sys, rows } = await setup();
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const source = await sys.tasks.create({ title: 'source', parent: epic.id });
    const orc = tg.as({ id: 'o', role: 'orchestrator' });
    await orc.moveClaimed((await orc.claim({ worker: 'w', leaseMs: 60_000 }))!, 'finish');
    await orc.move(epic.id, 'completeContainer');

    const out = { coverageGaps: [gap('login', 'no test for a wrong password')] } as unknown as ParikshakaOutput;
    await fileCoverageGaps(kshetra, out, source.id);
    await fileCoverageGaps(kshetra, out, source.id);
    expect(await rows(`select state, origin, parent_id, tags from taskgraph.tasks where 'parikshaka' = any(tags)`))
      .toEqual([{ state: 'proposed', origin: 'agent', parent_id: null, tags: ['parikshaka'] }]);
    expect(await rows(`select kind, b from taskgraph.task_links`)).toEqual([{ kind: 'discovered-from', b: source.id }]);
  });

  it('a gap whose epic is still open goes under it', async () => {
    const { sys, rows } = await setup();
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const source = await sys.tasks.create({ title: 'source', parent: epic.id });
    await fileCoverageGaps(kshetra, { coverageGaps: [gap('x', 'y')] } as unknown as ParikshakaOutput, source.id);
    expect(await rows(`select parent_id from taskgraph.tasks where 'parikshaka' = any(tags)`)).toEqual([{ parent_id: epic.id }]);
  });
});

describe("the agent loop's tracker on the engine", { timeout: PGLITE_TIMEOUT }, () => {
  it('prime gives the memories, show gives the task with its acceptance criteria, flag blocks it', async () => {
    const { shreni, tg, sys, rows } = await setup();
    const t = await sys.tasks.create({ title: 'Add login', description: 'users sign in' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: t.id, given: 'a user', when: 'they sign in', then: 'they see the home page', mode: 'auto' }).execute());
    const tracker = trackerFor(kshetra);
    await tracker.remember('tests live under src/**/*.test.ts');
    await tracker.remember('tests live under src/**/*.test.ts');
    expect(await tracker.prime()).toMatch(/tests live under/);
    expect(await rows(`select count(*)::int n from shreni.memories`)).toEqual([{ n: 1 }]);
    const shown = await tracker.show(t.id);
    expect(JSON.parse(shown)[0]).toMatchObject({ id: t.id, title: 'Add login', description: 'users sign in' });
    expect(parseAcceptanceCriteria(shown, t.id)).toMatch(/Given a user, when they sign in, then they see the home page/);
    await tracker.addNote(t.id, 'round 1');
    await tracker.flag(t.id, 'kept failing');
    expect((await tg.tasks.get(t.id)).state).toBe('blocked');
  });

  it('acceptance recorded on the attempt lets a task with checks finish', async () => {
    const { shreni, tg, sys, as, claims, store } = await setup();
    const t = await sys.tasks.create({ title: 't' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: t.id, given: 'g', when: 'w', then: 'th', mode: 'auto' }).execute());
    const c = (await as.claim({ worker: 'w', leaseMs: 60_000 }))!;
    claims.set(t.id, c);
    await store.recordAcceptance(t.id, true);
    await store.finish(t.id, 'merged');
    expect((await tg.tasks.get(t.id)).state).toBe('done');
  });
});

describe('review follow-ups (T4.6)', { timeout: PGLITE_TIMEOUT }, () => {
  const addCheck = (shreni: any, project: string, task: string, mode: 'auto' | 'manual') =>
    shreni.transaction((db: any) => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: project, task_id: task, given: 'g', when: 'w', then: 'th', mode }).execute());

  it('a PR follow-up keeps the approved acceptance, so the merge still finishes the task', async () => {
    const { shreni, tg, sys, as, claims, store } = await setup();
    const t = await sys.tasks.create({ title: 't' });
    await addCheck(shreni, tg.id, t.id, 'auto');
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    await store.recordAcceptance(t.id, true);
    await store.deferForPr(t.id, 'https://x/pull/1');
    claims.delete(t.id);
    await store.needsFollowup(t.id);
    const c2 = (await as.claim({ worker: 'w', leaseMs: 60_000 }))!;
    expect(c2.task.id).toBe(t.id);
    claims.set(t.id, c2);
    await store.resubmit(t.id, 'nothing to do');
    claims.delete(t.id);
    expect((await tg.tasks.get(t.id)).state).toBe('waiting');
    await store.finish(t.id, 'PR merged');
    expect((await tg.tasks.get(t.id)).state).toBe('done');
  });

  it('green gates and an approval do not pass a manual check: finish waits for the developer', async () => {
    const { shreni, tg, sys, as, claims, store } = await setup();
    const t = await sys.tasks.create({ title: 't' });
    await addCheck(shreni, tg.id, t.id, 'auto');
    await addCheck(shreni, tg.id, t.id, 'manual');
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    await store.recordAcceptance(t.id, true);
    await expect(store.finish(t.id, 'merged')).rejects.toThrow(/acceptance checks/);
  });

  it('a gap already filed but never linked is linked when it is seen again', async () => {
    const { tg, sys, store, rows } = await setup();
    const source = await sys.tasks.create({ title: 'source' });
    await tg.as({ id: 'parikshaka', role: 'agent' }).tasks.create({ title: 'gap', key: 'gap:1' });
    expect(await store.fileGap({ title: 'gap', description: 'd', priority: 2, key: 'gap:1', sourceTaskId: source.id })).toBe('exists');
    expect(await rows(`select kind, b from taskgraph.task_links`)).toEqual([{ kind: 'discovered-from', b: source.id }]);
  });

  it('a gap whose epic completes as it is filed is filed standalone', async () => {
    const { tg, sys, store, rows } = await setup();
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const source = await sys.tasks.create({ title: 'source', parent: epic.id });
    const orc = tg.as({ id: 'o', role: 'orchestrator' });
    await orc.moveClaimed((await orc.claim({ worker: 'w', leaseMs: 60_000 }))!, 'finish');
    await orc.move(epic.id, 'completeContainer');
    // The store reads the epic as still open: it completed between that read and the create.
    const get = tg.tasks.get.bind(tg.tasks);
    tg.tasks.get = async (id: string) => {
      const task = await get(id);
      return id === epic.id ? { ...task, state: 'open' } : task;
    };
    expect(await store.fileGap({ title: 'gap', description: 'd', priority: 2, key: 'gap:2', sourceTaskId: source.id })).toBe('filed');
    expect(await rows(`select parent_id, state from taskgraph.tasks where key = 'gap:2'`)).toEqual([{ parent_id: null, state: 'proposed' }]);
  });
});
