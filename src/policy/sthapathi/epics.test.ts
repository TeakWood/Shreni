import { describe, it, expect, onTestFinished } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { reconcileContainers } from './epics';
import { Unavailable, type ActorHandle } from '../../taskgraph';

// Epics reconciled on the engine (policy spec, "Containers"): Sthapathi asks
// tasks.settled() on start and on each poll, completes a container with a
// finished child, and flags one whose children were all cancelled.

async function setup() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  const sys = tg.as({ id: 's', role: 'system' });
  const orc = tg.as({ id: 'o', role: 'orchestrator' });
  const finishNext = async () => orc.moveClaimed((await orc.claim({ worker: 'w', leaseMs: 60_000 }))!, 'finish');
  return { tg, sys, orc, finishNext };
}

describe('epics reconciled on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('an epic whose last child finished while the worker was stopped completes, up the chain', async () => {
    const { tg, sys, orc, finishNext } = await setup();
    const outer = await sys.tasks.create({ title: 'outer', kind: 'container' });
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container', parent: outer.id });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const b = await sys.tasks.create({ title: 'b', parent: epic.id });
    await finishNext();
    await tg.as({ id: 'd', role: 'developer' }).move(b.id, 'cancel');
    expect((await tg.tasks.get(a.id)).state).toBe('done');

    expect(await reconcileContainers({ tg, as: orc })).toEqual({ completed: [epic.id, outer.id], flagged: [] });
    expect((await tg.tasks.get(epic.id)).state).toBe('done');
    expect((await tg.tasks.get(outer.id)).state).toBe('done');
    expect(await reconcileContainers({ tg, as: orc })).toEqual({ completed: [], flagged: [] });
  });

  it('an epic whose children were all cancelled is flagged, once', async () => {
    const { tg, sys, orc } = await setup();
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    await tg.as({ id: 'd', role: 'developer' }).move(a.id, 'cancel');
    expect(await reconcileContainers({ tg, as: orc })).toEqual({ completed: [], flagged: [epic.id] });
    expect((await tg.tasks.get(epic.id)).state).toBe('blocked');
    expect(await reconcileContainers({ tg, as: orc })).toEqual({ completed: [], flagged: [] });
  });

  it('leaves an epic with live children, and one outside a scoped run', async () => {
    const { tg, sys, orc, finishNext } = await setup();
    const live = await sys.tasks.create({ title: 'live', kind: 'container' });
    await sys.tasks.create({ title: 'x', parent: live.id, priority: 3 });
    const other = await sys.tasks.create({ title: 'other', kind: 'container' });
    await sys.tasks.create({ title: 'y', parent: other.id, priority: 0 });
    await finishNext();
    expect(await reconcileContainers({ tg, as: orc, within: live.id })).toEqual({ completed: [], flagged: [] });
    expect((await tg.tasks.get(other.id)).state).toBe('open');
    expect(await reconcileContainers({ tg, as: orc })).toEqual({ completed: [other.id], flagged: [] });
    expect((await tg.tasks.get(live.id)).state).toBe('open');
  });

  it('a refused move is logged once and the rest go on; a lost database stops the reconcile', async () => {
    const { tg, sys, orc, finishNext } = await setup();
    const a = await sys.tasks.create({ title: 'a', kind: 'container' });
    await sys.tasks.create({ title: 'x', parent: a.id });
    const b = await sys.tasks.create({ title: 'b', kind: 'container' });
    await sys.tasks.create({ title: 'y', parent: b.id });
    await finishNext();
    await finishNext();
    // a's move is refused (as if a developer moved it meanwhile); b's goes through.
    const refusing = { move: (id: string, ...rest: unknown[]) => id === a.id
      ? Promise.reject(Object.assign(new Error('refused'), { code: 'MoveRefused' }))
      : (orc.move as (...x: unknown[]) => Promise<unknown>)(id, ...rest) } as unknown as ActorHandle;
    const logs: string[] = [];
    expect(await reconcileContainers({ tg, as: refusing, log: m => logs.push(m) })).toEqual({ completed: [b.id], flagged: [] });
    expect(logs.filter(l => l.includes(`could not reconcile epic ${a.id}`))).toHaveLength(1);

    const down = { move: () => Promise.reject(new Unavailable('gone')) } as unknown as ActorHandle;
    await expect(reconcileContainers({ tg, as: down, retry: { forMs: 0 } })).rejects.toBeInstanceOf(Unavailable);
    expect((await tg.tasks.get(a.id)).state).toBe('open');
  });
});
