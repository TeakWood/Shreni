import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { Unavailable } from '../../taskgraph';
import { EngineQueue, retryUnavailable } from './leases';
import { engineHooks } from './hooks';
import type { KshetraConfig } from '../../kshetra/config.js';

// The worker on the engine (policy spec, "Running work").

const kshetra = { id: 'web' } as KshetraConfig;

async function setup(opts: { heartbeatMs?: number } = {}) {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  const orc = tg.as({ id: 'sthapathi', role: 'orchestrator' });
  const claimSpy = vi.spyOn(orc, 'claim');
  const beatSpy = vi.spyOn(orc, 'heartbeat');
  const queue = new EngineQueue(tg, orc, 'host/1', { heartbeatMs: opts.heartbeatMs ?? 20 });
  const rows = async (q: string, params: unknown[] = []) => (await t.pglite.query<any>(q, params)).rows;
  return { tg, orc, queue, claimSpy, beatSpy, rows, sys: tg.as({ id: 'sys', role: 'system' }) };
}

describe('engine hooks', { timeout: PGLITE_TIMEOUT }, () => {
  it('claims a ready task in one call, and heartbeats while the agents run', async () => {
    const { queue, claimSpy, beatSpy, sys, rows } = await setup();
    const t = await sys.tasks.create({ title: 'Fix the login bug' });
    let leaseDuring: Date | undefined;
    const hooks = engineHooks({
      queue, preflight: async () => {}, onUnavailable: () => {},
      run: async (task, _k, signal) => {
        expect(signal.aborted).toBe(false);
        await new Promise(r => setTimeout(r, 120));
        leaseDuring = (await rows(`select lease_expires_at from taskgraph.tasks where id = $1`, [task.id]))[0].lease_expires_at;
      },
    });
    const peeked = await hooks.selectNext(kshetra);
    expect(peeked).toMatchObject({ id: t.id, slug: 'fix-the-login-bug' });
    const prepared = await hooks.prepareTask(peeked!, kshetra);
    expect(prepared).toMatchObject({ id: t.id, status: 'in_progress' });
    expect(claimSpy).toHaveBeenCalledTimes(1);
    const leaseAtClaim = (await rows(`select lease_expires_at from taskgraph.tasks where id = $1`, [t.id]))[0].lease_expires_at;
    await hooks.runTask(prepared!, kshetra);
    expect(beatSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(leaseDuring!.getTime()).toBeGreaterThan(leaseAtClaim.getTime());
    expect(await rows(`select worker from taskgraph.attempts`)).toEqual([{ worker: 'host/1' }]);
  });

  it('gives the claim back when preflight refuses the work tree', async () => {
    const { queue, sys, rows } = await setup();
    await sys.tasks.create({ title: 't' });
    const hooks = engineHooks({ queue, preflight: async () => { throw new Error('dirty tree'); }, run: async () => {}, onUnavailable: () => {} });
    expect(await hooks.prepareTask((await hooks.selectNext(kshetra))!, kshetra)).toBeNull();
    expect(await rows(`select state from taskgraph.tasks`)).toEqual([{ state: 'open' }]);
    expect(await rows(`select outcome from taskgraph.attempts`)).toEqual([{ outcome: 'release' }]);
  });

  it('aborts the agents when the lease is lost, and reports it', async () => {
    const { queue, sys, tg } = await setup();
    await sys.tasks.create({ title: 't' });
    const lost = vi.fn();
    let aborted = false;
    const hooks = engineHooks({
      queue, preflight: async () => {}, onUnavailable: () => {}, onLeaseLost: lost,
      run: async (task, _k, signal) => {
        // a developer cancels the task under the worker
        await tg.as({ id: 'dev', role: 'developer' }).move(task.id, 'cancel');
        await new Promise<void>(r => { signal.addEventListener('abort', () => { aborted = true; r(); }); });
      },
    });
    const task = (await hooks.prepareTask((await hooks.selectNext(kshetra))!, kshetra))!;
    await hooks.runTask(task, kshetra);
    expect(aborted).toBe(true);
    expect(lost).toHaveBeenCalledWith(task);
  });

  it('returns nothing to do when nothing is ready', async () => {
    const { queue } = await setup();
    const hooks = engineHooks({ queue, preflight: async () => {}, run: async () => {}, onUnavailable: () => {} });
    expect(await hooks.selectNext(kshetra)).toBeNull();
  });
});

describe('an unavailable database', () => {
  it('is retried within the window, then pauses the Kshetra', async () => {
    let now = 0;
    const sleep = async (ms: number) => { now += ms; };
    let fails = 3;
    expect(await retryUnavailable(async () => { if (fails-- > 0) throw new Unavailable('down'); return 'ok'; }, { forMs: 60_000, sleep, now: () => now }))
      .toBe('ok');

    const paused = vi.fn();
    const queue = { sweep: async () => { throw new Unavailable('down'); } } as unknown as EngineQueue;
    const hooks = engineHooks({ queue, preflight: async () => {}, run: async () => {}, onUnavailable: paused, retry: { forMs: 60_000, sleep, now: () => now } });
    now = 0;
    expect(await hooks.selectNext(kshetra)).toBeNull();
    expect(paused).toHaveBeenCalledTimes(1);
    expect(now).toBeGreaterThanOrEqual(60_000);
  });
});

describe('review follow-ups (T4.4)', { timeout: PGLITE_TIMEOUT }, () => {
  it('a claim whose reply was lost is retried with its request id: one attempt, not a second task', async () => {
    const { queue, sys, rows } = await setup();
    await sys.tasks.create({ title: 'a' });
    await sys.tasks.create({ title: 'b' });
    const real = queue.claim.bind(queue);
    let first = true;
    queue.claim = async (rid: string) => {
      const c = await real(rid);
      if (first) { first = false; throw new Unavailable('reply lost'); }
      return c;
    };
    const hooks = engineHooks({ queue, preflight: async () => {}, run: async () => {}, onUnavailable: () => {}, retry: { sleep: async () => {} } });
    const task = await hooks.prepareTask((await hooks.selectNext(kshetra))!, kshetra);
    expect(task).not.toBeNull();
    expect(await rows(`select count(*)::int n from taskgraph.attempts`)).toEqual([{ n: 1 }]);
    expect(await rows(`select count(*)::int n from taskgraph.tasks where state = 'claimed'`)).toEqual([{ n: 1 }]);
  });

  it('a run that ends without moving its task gives the claim back; a refusal is reported', async () => {
    const { queue, sys, rows } = await setup();
    await sys.tasks.create({ title: 't' });
    const refused = vi.fn();
    const hooks = engineHooks({ queue, preflight: async () => {}, run: async () => {}, onUnavailable: () => {}, onPreflightRefused: refused });
    const task = (await hooks.prepareTask((await hooks.selectNext(kshetra))!, kshetra))!;
    await hooks.runTask(task, kshetra);
    expect(await rows(`select state from taskgraph.tasks`)).toEqual([{ state: 'open' }]);
    expect(await rows(`select outcome from taskgraph.attempts`)).toEqual([{ outcome: 'release' }]);

    const failing = engineHooks({ queue, preflight: async () => { throw new Error('dirty'); }, run: async () => {}, onUnavailable: () => {}, onPreflightRefused: refused });
    expect(await failing.prepareTask((await failing.selectNext(kshetra))!, kshetra)).toBeNull();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), kshetra, expect.any(Error));
  });

  it('claims only within the scoped epic', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg = shreni.tg.project(p.id);
    const sys = tg.as({ id: 's', role: 'system' });
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    await sys.tasks.create({ title: 'outside', priority: 0 });
    const inside = await sys.tasks.create({ title: 'inside', parent: epic.id, priority: 4 });
    const queue = new EngineQueue(tg, tg.as({ id: 'o', role: 'orchestrator' }), 'h/1', { within: epic.id });
    const hooks = engineHooks({ queue, preflight: async () => {}, run: async () => {}, onUnavailable: () => {} });
    expect((await hooks.selectNext(kshetra))!.id).toBe(inside.id);
    expect((await hooks.prepareTask({} as never, kshetra))!.id).toBe(inside.id);
  });
});
