import { describe, it, expect } from 'vitest';
import { openEngine } from './test/engine';
import { createMigratedTestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { openTaskGraph } from './client';
import { InvalidRequest } from './errors';
import type { TaskGraphEvent } from './types';

// Notifications (engine spec, "Events and history"): each transaction that
// writes events notifies with the project and its highest event id, on commit
// only; events.subscribe reads the rows itself from its cursor.

/** Resolves once `pred` holds, polling briefly; fails after `ms`. */
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('events.subscribe', { timeout: 30_000 }, () => {
  it('delivers the project\'s new events in order, from now, and nothing of another project\'s', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    await sys.tasks.create({ title: 'before' });
    const got: TaskGraphEvent[] = [];
    const unsubscribe = await e.tg.events.subscribe(events => { got.push(...events); });
    const other = e.client.project((await e.client.projects.create({ name: 'api', idPrefix: 'api', actor: { id: 'ann', role: 'developer' } })).id);
    await other.as({ id: 'system', role: 'system' }).tasks.create({ title: 'elsewhere' });
    const a = await sys.tasks.create({ title: 'a' });
    const b = await sys.tasks.create({ title: 'b' });
    await until(() => got.length >= 2);
    expect(got.map(x => [x.kind, x.taskId])).toEqual([['task.created', a.id], ['task.created', b.id]]);
    expect(BigInt(got[1].id) > BigInt(got[0].id)).toBe(true);
    await unsubscribe();
    await sys.tasks.create({ title: 'after' });
    await new Promise(r => setTimeout(r, 100));
    expect(got).toHaveLength(2);
  });

  it('notifies on commit only, and resumes from a cursor', async () => {
    const e = await openEngine();
    const sys = e.as('system');
    const first = await sys.tasks.create({ title: 'first' });
    const [created] = await e.tg.events.since('0');
    expect(created.kind).toBe('project.created');
    // A write that rolls back notifies nothing, and leaves nothing to read.
    await expect(sys.tasks.create({ title: '' })).rejects.toThrow();
    const got: TaskGraphEvent[] = [];
    const unsubscribe = await e.tg.events.subscribe(events => { got.push(...events); }, { after: created.id });
    // Subscribing catches up from the cursor at once.
    await until(() => got.length >= 1);
    expect(got.map(x => x.taskId)).toEqual([first.id]);
    await unsubscribe();
  });

  it('catches up after the listener reconnects, delivering what was written while it was down', async () => {
    const t = await createMigratedTestDb();
    // A listen that can be cut off: while down it delivers nothing, then reports its re-listen.
    let relisten: () => void = () => {};
    let up = true;
    const client = await openTaskGraph({
      db: t.db, lifecycle: testLifecycle(),
      listen: async (channel, onNotify, onRelisten) => {
        const un = await t.pglite.listen(channel, p => { if (up) onNotify(p); });
        relisten = onRelisten ?? (() => {});
        return un;
      },
    });
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'ann', role: 'developer' } });
    const tg = client.project(p.id);
    const got: TaskGraphEvent[] = [];
    const unsubscribe = await tg.events.subscribe(events => { got.push(...events); });
    up = false;
    const sys = tg.as({ id: 'system', role: 'system' });
    const missed = [await sys.tasks.create({ title: 'while down 1' }), await sys.tasks.create({ title: 'while down 2' })];
    await new Promise(r => setTimeout(r, 50));
    expect(got).toEqual([]);
    up = true;
    relisten();
    await until(() => got.length >= 2);
    expect(got.map(e => e.taskId)).toEqual(missed.map(m => m.id));
    await unsubscribe();
    await client.close();
    await t.close();
  });

  it('serves several subscribers from one LISTEN, and one unsubscribing leaves the others', async () => {
    const e = await openEngine();
    const a: TaskGraphEvent[] = [];
    const b: TaskGraphEvent[] = [];
    const ua = await e.tg.events.subscribe(x => { a.push(...x); });
    const ub = await e.tg.events.subscribe(x => { b.push(...x); });
    await ua();
    const t1 = await e.as('system').tasks.create({ title: 'one' });
    await until(() => b.some(x => x.taskId === t1.id));
    await new Promise(r => setTimeout(r, 50));
    expect(a).toEqual([]);
    await ub();
  });

  it('needs a session connection, or a listen, to subscribe', async () => {
    const t = await createMigratedTestDb();
    const client = await openTaskGraph({ db: t.db, lifecycle: testLifecycle() });
    const p = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'ann', role: 'developer' } });
    await expect(client.project(p.id).events.subscribe(() => {})).rejects.toBeInstanceOf(InvalidRequest);
    await client.close();
    await t.close();
  });
});
