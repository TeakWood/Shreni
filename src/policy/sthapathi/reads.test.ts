import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { engineTaskStore } from './task-store';
import { engineReads } from './reads';
import { registerEngineStore, unregisterEngineStore } from '../../sthapathi/task-store';
import type { KshetraConfig } from '../../kshetra/config';

// Reads on the engine (engine spec, "API"; migration plan, "Replacing today's
// bd wrapper"): the CLI and Phalaka parse the same bd-shaped rows from it.

let registry: KshetraConfig[] = [];
// The one-shot and shared paths open a connection; here, onto the test database.
const opened = { count: 0, closed: 0, shreni: undefined as unknown };
vi.mock('./connect', () => ({
  openKshetraEngine: async () => {
    opened.count++;
    return { shreni: opened.shreni, close: async () => { opened.closed++; } };
  },
}));
vi.mock('../../kshetra/registry', async orig => ({ ...(await orig<object>()), loadRegistry: () => registry }));

async function setup() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  const kshetra = { id: 'web-reads', name: 'web', project: p.id, beads: { path: '/nonexistent' } } as unknown as KshetraConfig;
  const as = tg.as({ id: 'o', role: 'orchestrator' });
  registerEngineStore(kshetra.id, engineTaskStore({
    shreni, tg, as, claimFor: () => undefined,
    systemActor: tg.as({ id: 's', role: 'system' }), agentActor: tg.as({ id: 'p', role: 'agent' }),
  }));
  registry = [kshetra];
  onTestFinished(async () => { unregisterEngineStore(kshetra.id); registry = []; await shreni.close(); await t.close(); });
  return { t, shreni, tg, kshetra, as, sys: tg.as({ id: 's', role: 'system' }) };
}

const captureLog = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  onTestFinished(() => spy.mockRestore());
  return lines;
};

describe('reads on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('shreni logs gives a task\'s notes oldest first', async () => {
    const { sys, as, kshetra } = await setup();
    const task = await sys.tasks.create({ title: 'Add login' });
    for (const n of ['Round 1: dispatching silpi', 'Round 1: submitted for review', 'Round 2: dispatching silpi', 'Paused: API unavailable']) {
      await as.notes.add(task.id, n);
    }
    const lines = captureLog();
    const { runLogs } = await import('../../cli/logs');
    await runLogs({ beadId: task.id, kshetraId: kshetra.id, all: false });
    const out = lines.join('\n');
    expect(out).toContain(`[open] ${task.id} · Add login`);
    expect(out.indexOf('dispatching silpi')).toBeLessThan(out.indexOf('submitted for review'));
    expect(out).toMatch(/Round 1:\n\s+dispatching silpi\n\s+submitted for review\n\s+Round 2:\n\s+dispatching silpi\n\s+Paused: API unavailable/);
  });

  it('shreni export takes all 400 closed tasks', async () => {
    const { t, tg, sys, kshetra } = await setup();
    for (let i = 0; i < 400; i++) await sys.tasks.create({ title: `t${i}` });
    await t.pglite.query(`update taskgraph.tasks set state = 'done', closed_at = now() where project_id = $1`, [tg.id]);
    const { parseBeads, defaultDeps } = await import('../../cli/export');
    const beads = parseBeads(await defaultDeps.loadBeadsJson(kshetra));
    expect(beads).toHaveLength(400);
    expect(new Set(beads.map(b => b.status))).toEqual(new Set(['closed']));
  });

  it('rows carry bd\'s status, labels, parent, dependencies and acceptance criteria', async () => {
    const { shreni, tg, sys } = await setup();
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id, tags: ['ui'] });
    const b = await sys.tasks.create({ title: 'b', parent: epic.id });
    await tg.as({ id: 'd', role: 'developer' }).deps.add(b.id, a.id);
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: b.id, given: 'g', when: 'w', then: 'th', mode: 'auto' }).execute());
    const reads = engineReads(shreni, tg);
    const [row] = JSON.parse(await reads.show(b.id));
    expect(row).toMatchObject({
      id: b.id, status: 'open', issue_type: 'task', parent: epic.id, acceptance_criteria: '- Given g, when w, then th',
      dependencies: [{ id: a.id, status: 'open', dependency_type: 'blocks', type: 'blocks', issue_id: b.id, depends_on_id: a.id }],
    });
    expect(JSON.parse(await reads.list({ label: 'ui' })).map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect(JSON.parse(await reads.list({ type: 'epic' })).map((r: { id: string }) => r.id)).toEqual([epic.id]);
    expect(JSON.parse(await reads.children(epic.id)).map((r: { id: string }) => r.id)).toEqual([a.id, b.id]);
    expect(JSON.parse(await reads.ready()).map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect(JSON.parse(await reads.list({ status: 'closed' }))).toEqual([]);
  });

  it('Phalaka lists and shows engine tasks, status by status', async () => {
    const { sys, as, kshetra, t } = await setup();
    const a = await sys.tasks.create({ title: 'a' });
    const b = await sys.tasks.create({ title: 'b' });
    await t.pglite.query(`update taskgraph.tasks set state = 'done', closed_at = now() where id = $1`, [b.id]);
    await as.notes.add(a.id, 'Round 1: dispatching silpi');
    const { beadsRead, clearBeadsReadCache } = await import('../../phalaka/beads-read');
    clearBeadsReadCache();
    const reader = beadsRead(kshetra);
    expect((await reader.list()).map(x => [x.id, x.status])).toEqual([[a.id, 'open']]);
    expect((await reader.list({ status: 'closed' })).map(x => x.id)).toEqual([b.id]);
    expect(await reader.show(a.id)).toMatchObject({ id: a.id, notes: 'Round 1: dispatching silpi' });
  });

  it('flag reasons read as notes (as bd appended them), and a closed task carries its reason', async () => {
    const { tg, sys, as, kshetra } = await setup();
    const a = await sys.tasks.create({ title: 'a' });
    await as.notes.add(a.id, 'Round 1: dispatching silpi');
    await as.move(a.id, 'flag', { reason: '[needs-human] Could not restore green' });
    const b = await sys.tasks.create({ title: 'b' });
    await tg.as({ id: 'd', role: 'developer' }).move(b.id, 'cancel', { reason: 'not needed' });
    const { classifyOpenBeads } = await import('../../cli/drain-classify');
    expect(await classifyOpenBeads(kshetra, [a.id], { paused: false, readyIds: new Set() }))
      .toEqual([{ beadId: a.id, category: 'needs-human', reason: 'needs-human' }]);
    const { withTrackerReads } = await import('./reads');
    const [row] = JSON.parse(await withTrackerReads(kshetra, r => r.show(a.id)));
    expect(row.notes).toBe('Round 1: dispatching silpi\n[needs-human] Could not restore green');
    const [closed] = JSON.parse(await withTrackerReads(kshetra, r => r.show(b.id)));
    expect(closed).toMatchObject({ status: 'closed', state: 'cancelled', close_reason: 'not needed' });
  });

  it('a cancelled dependency still blocks; a flagged follow-up loses its label; proposed tasks export as plan-time', async () => {
    const { t, shreni, tg, sys } = await setup();
    const dev = tg.as({ id: 'd', role: 'developer' });
    const a = await sys.tasks.create({ title: 'a' });
    const b = await sys.tasks.create({ title: 'b' });
    await dev.deps.add(b.id, a.id);
    // The engine won't cancel a task others wait on (unless it drops the edges);
    // the mapping still reads one that is cancelled as not closed.
    await t.pglite.query(`update taskgraph.tasks set state = 'cancelled', closed_at = now() where id = $1`, [a.id]);
    const reads = engineReads(shreni, tg);
    expect(JSON.parse(await reads.show(b.id))[0].dependencies[0].status).toBe('cancelled');

    const c = await sys.tasks.create({ title: 'c' });
    await t.pglite.query(`update taskgraph.tasks set boosted = true where id = $1`, [c.id]);
    expect(JSON.parse(await reads.list({ label: 'pr-needs-followup' })).map((r: { id: string }) => r.id)).toEqual([c.id]);
    await tg.as({ id: 'o', role: 'orchestrator' }).move(c.id, 'flag', { reason: 'escalated' });
    expect(JSON.parse(await reads.list({ label: 'pr-needs-followup' }))).toEqual([]);

    const planned = await tg.as({ id: 'p', role: 'agent' }).tasks.create({ title: 'planned' });
    const { parseBeads, findExecutedBeads } = await import('../../cli/export');
    const beads = parseBeads(await reads.list({ status: 'all' })).filter(x => x.id === planned.id);
    expect(beads[0].status).toBe('proposed');
    expect(findExecutedBeads(beads)).toEqual([]);
  });

  it('without the worker in this process: a one-shot read opens and closes; a shared one opens once', async () => {
    const { shreni, sys, kshetra } = await setup();
    const a = await sys.tasks.create({ title: 'a' });
    unregisterEngineStore(kshetra.id);
    opened.shreni = shreni;
    Object.assign(opened, { count: 0, closed: 0 });
    const { withTrackerReads } = await import('./reads');
    expect(JSON.parse(await withTrackerReads(kshetra, r => r.show(a.id)))[0].id).toBe(a.id);
    expect(opened).toMatchObject({ count: 1, closed: 1 });
    await withTrackerReads(kshetra, r => r.ready(), { shared: true });
    await withTrackerReads(kshetra, r => r.ready(), { shared: true });
    expect(opened).toMatchObject({ count: 2, closed: 1 });
    const { collectEpicScope } = await import('../../cli/drain');
    expect([...await collectEpicScope(kshetra, a.id)]).toEqual([a.id]);
  });
});
