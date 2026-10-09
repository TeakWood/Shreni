import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import type { KshetraConfig } from '../kshetra/config';

// Live task views (policy spec, "Running work"): Phalaka follows each
// Kshetra's events, drops the project's cached reads and rings the browser.

const invalidated: string[] = [];
vi.mock('./beads-read.js', () => ({ invalidateProjectReads: (p: string) => { invalidated.push(p); } }));
const { TaskFeed } = await import('./live.js');

async function engine() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle, listen: (c, f) => t.pglite.listen(c, f) });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const k = { id: 'web', project: p.id } as unknown as KshetraConfig;
  return { tg: shreni.tg.project(p.id), k };
}

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('the live task feed', { timeout: PGLITE_TIMEOUT }, () => {
  it('given Phalaka open, when a task is claimed, then the browser is rung within 1 s, its reads already dropped', async () => {
    const { tg, k } = await engine();
    const task = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'to claim' });
    const rung: { kshetraId: string; taskIds: string[] }[] = [];
    const feed = new TaskFeed({
      kshetras: () => [k],
      onChange: (kshetraId, taskIds) => rung.push({ kshetraId, taskIds }),
      subscribe: async (kk, handler, onError) => tg.events.subscribe(handler, { onError }),
    });
    feed.start();
    onTestFinished(() => feed.close());
    await new Promise(r => setTimeout(r, 50)); // subscribed
    invalidated.length = 0;

    const t0 = Date.now();
    await tg.as({ id: 'sthapathi:web', role: 'orchestrator' }).claim({ worker: 'host/1', leaseMs: 60_000 });
    await until(() => rung.some(r => r.taskIds.includes(task.id)), 1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(rung.at(-1)).toEqual({ kshetraId: 'web', taskIds: [task.id] });
    expect(invalidated).toContain(k.project);
  });

  it('follows the registry: a Kshetra that leaves is unsubscribed, one with no project never subscribed, a failure retried', async () => {
    const unsubscribed: string[] = [];
    let fail = true;
    const subscribe = vi.fn(async (k: KshetraConfig) => {
      if (k.id === 'flaky' && fail) throw new Error('database down');
      return async () => { unsubscribed.push(k.id); };
    });
    let list = [{ id: 'a', project: 'p-a' }, { id: 'beads' }, { id: 'flaky', project: 'p-f' }] as unknown as KshetraConfig[];
    const logs: string[] = [];
    const feed = new TaskFeed({ kshetras: () => list, onChange: () => {}, subscribe: subscribe as never, log: l => logs.push(l) });
    feed.sync();
    await new Promise(r => setTimeout(r, 10));
    expect(subscribe.mock.calls.map(c => c[0].id)).toEqual(['a', 'flaky']);
    expect(logs).toEqual([`[phalaka] can't follow flaky's events: database down`]);

    fail = false;
    list = [{ id: 'flaky', project: 'p-f' }] as unknown as KshetraConfig[];
    feed.sync();
    await new Promise(r => setTimeout(r, 10));
    expect(unsubscribed).toEqual(['a']);
    expect(subscribe.mock.calls.map(c => c[0].id)).toEqual(['a', 'flaky', 'flaky']);
    await feed.close();
    expect(unsubscribed).toEqual(['a', 'flaky']);
  });
});
