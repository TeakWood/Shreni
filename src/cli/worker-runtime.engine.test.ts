import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import type { KshetraConfig } from '../kshetra/config';
import { defineLifecycle } from '../taskgraph';

// The worker runtime in engine mode (policy spec, "Running work"): a Kshetra
// whose kshetra.yaml names its engine project is worked through the engine;
// one with no project is refused. Git, the agents and the lot manifest are stubbed.

let shreni: ShreniClient;
const run = vi.fn(async () => { await new Promise(r => setTimeout(r, 30)); return { approved: true, note: 'ok' }; });

vi.mock('../policy/sthapathi/connect', () => ({
  openKshetraEngine: async () => ({ shreni, close: async () => {} }),
}));
vi.mock('../sthapathi/dispatch', () => ({ runSilpiViharapalaLoop: (...a: unknown[]) => run(...(a as [])) }));
vi.mock('../sthapathi/recover', async orig => ({ ...(await orig<object>()), resetWorkTree: async () => {} }));
// The work tree check is stubbed; the health gate runs for real, on a stubbed suite.
let baseGreen = true;
vi.mock('../sthapathi/health', async orig => ({
  ...(await orig<object>()),
  checkHealth: async () => ({ green: baseGreen, failCount: baseGreen ? 0 : 3, baseline: 0, sha: 'x' }),
}));
vi.mock('../sthapathi/pickup', async orig => {
  const real = await orig<typeof import('../sthapathi/pickup')>();
  return {
    ...real,
    preFlightFresh: async (task: never, k: never) => { if (!(await real.healthGate(task, k))) throw new real.BaseRedError(task); },
  };
});
vi.mock('../sthapathi/lot-manifest', async orig => ({ ...(await orig<object>()), collectLotManifest: async () => ({}) }));
vi.mock('../ext/loader', async orig => ({ ...(await orig<object>()), loadExtension: async () => false }));
const paused = vi.fn();
vi.mock('../kshetra/state', async orig => ({
  ...(await orig<object>()),
  pauseKshetra: (...a: unknown[]) => { paused(...a); },
}));

async function setup() {
  const t = await createTestDb();
  shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const dir = mkdtempSync(join(tmpdir(), 'shreni-engine-'));
  const kshetra = {
    id: 'web', name: 'web', project: p.id, database: 'local', plan: { validators: {} },
    repo: { path: dir, remote: 'x', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    stack: { language: 'ts' },
    gates: { build: { level: 'block' }, test: { level: 'block' }, lint: { level: 'warn' } },
    agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 }, priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
    conventions: {},
  } as unknown as KshetraConfig;
  return { t, tg: shreni.tg.project(p.id), kshetra };
}

describe('the worker runtime on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('on a red main, gives the claim back, files one repair task, and works the repair next', async () => {
    const { t, tg, kshetra } = await setup();
    const feature = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'Do the thing', priority: 2 });
    const { createWorkerRuntime } = await import('./worker-runtime');
    const runtime = createWorkerRuntime(kshetra, { entrypoint: 'drain' });
    await runtime.startup();
    baseGreen = false;
    onTestFinished(() => { baseGreen = true; });
    run.mockClear();

    await runtime.scheduler.runCycle(kshetra, runtime.hooks);
    expect(run).not.toHaveBeenCalled();
    const health = await tg.tasks.list({ tags: ['shreni-health'] });
    expect(health).toEqual([expect.objectContaining({ state: 'open', priority: 0, title: expect.stringMatching(/^\[shreni-health\]/) })]);
    expect(await t.pglite.query<any>(`select task_id, outcome from taskgraph.attempts`).then(r => r.rows))
      .toEqual([{ task_id: feature.id, outcome: 'release' }]);

    // The repair task is exempt from the gate and comes first.
    expect(await runtime.scheduler.runCycle(kshetra, runtime.hooks)).toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ id: health[0].id });
    await runtime.close();
  });

  it('on start, completes an epic whose last child finished while the worker was stopped', async () => {
    const { tg, kshetra } = await setup();
    const sys = tg.as({ id: 's', role: 'system' });
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    await sys.tasks.create({ title: 'child', parent: epic.id });
    const orc = tg.as({ id: 'o', role: 'orchestrator' });
    await orc.moveClaimed((await orc.claim({ worker: 'w', leaseMs: 60_000 }))!, 'finish');
    expect((await tg.tasks.get(epic.id)).state).toBe('open');

    const { createWorkerRuntime } = await import('./worker-runtime');
    const runtime = createWorkerRuntime(kshetra, { entrypoint: 'drain' });
    await runtime.startup();
    expect((await tg.tasks.get(epic.id)).state).toBe('done');

    // And on each poll: an epic whose last child finishes while it runs.
    const later = await sys.tasks.create({ title: 'later', kind: 'container' });
    await sys.tasks.create({ title: 'child 2', parent: later.id });
    await orc.moveClaimed((await orc.claim({ worker: 'w', leaseMs: 60_000 }))!, 'finish');
    await runtime.hooks.selectNext(kshetra);
    expect((await tg.tasks.get(later.id)).state).toBe('done');
    await runtime.close();
  });

  it('on a project still on an older lifecycle, pauses once with the command that upgrades it', async () => {
    const t = await createTestDb();
    const v1 = defineLifecycle({ ...taskLifecycle, version: 1, moves: taskLifecycle.moves.filter(m => m.name !== 'confirm') });
    const old = await openShreni({ db: t.db, lifecycle: v1 });
    await old.migrate();
    const p = await old.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    await old.close();
    shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    const { kshetra } = { kshetra: { id: 'web', name: 'web', project: p.id, database: 'local', repo: { path: mkdtempSync(join(tmpdir(), 'shreni-engine-')) } } as unknown as KshetraConfig };
    paused.mockClear();
    const { createWorkerRuntime } = await import('./worker-runtime');
    const runtime = createWorkerRuntime(kshetra, { entrypoint: 'drain' });
    await expect(runtime.startup()).rejects.toThrow(/run shreni task upgrade in its repo, then shreni resume --kshetra web/);
    expect(paused).toHaveBeenCalledWith(kshetra, expect.objectContaining({
      manual: true, reason: 'lifecycle_behind',
      message: expect.stringMatching(/web: its project is on shreni\.task@1, older than this Shreni's shreni\.task@2; run shreni task upgrade/),
    }));
    await runtime.close();
  });

  it('given an idle worker, when a task becomes ready, then it is claimed within 1 s', async () => {
    run.mockClear();
    const t = await createTestDb();
    shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle, listen: (c, f) => t.pglite.listen(c, f) });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const kshetra = {
      id: 'web', name: 'web', project: p.id, database: 'local', plan: { validators: {} },
      repo: { path: mkdtempSync(join(tmpdir(), 'shreni-engine-')), remote: 'x', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
      stack: { language: 'ts' },
      gates: { build: { level: 'block' }, test: { level: 'block' }, lint: { level: 'warn' } },
      agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 }, priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
      conventions: {},
    } as unknown as KshetraConfig;
    const { createWorkerRuntime } = await import('./worker-runtime');
    const runtime = createWorkerRuntime(kshetra, { entrypoint: 'drain' });
    await runtime.startup();
    // A minute between polls: only the wake-up can make this quick.
    const loop = runtime.scheduler.scheduleLoop(kshetra, runtime.hooks, 60_000);
    runtime.onWake(() => loop.wake());
    onTestFinished(() => loop());

    const t0 = Date.now();
    const task = await shreni.tg.project(p.id).as({ id: 's', role: 'system' }).tasks.create({ title: 'ready now' });
    while (run.mock.calls.length === 0 && Date.now() - t0 < 1_000) await new Promise(r => setTimeout(r, 10));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await t.pglite.query<any>(`select task_id from taskgraph.attempts`).then(r => r.rows)).toEqual([{ task_id: task.id }]);
    loop();
    await runtime.close();
  });

  it('claims and runs through the engine and takes the worker lock', async () => {
    run.mockClear();
    const t = await createTestDb();
    shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
    const tg = shreni.tg.project(p.id);
    const task = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'Do the thing' });

    const dir = mkdtempSync(join(tmpdir(), 'shreni-engine-'));
    const kshetra = {
      id: 'web', name: 'web', project: p.id, database: 'local', plan: { validators: {} },
      repo: { path: dir, remote: 'x', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
      stack: { language: 'ts' },
      gates: { build: { level: 'block' }, test: { level: 'block' }, lint: { level: 'warn' } },
      agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 }, priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
      conventions: {},
    } as unknown as KshetraConfig;

    const { createWorkerRuntime } = await import('./worker-runtime');
    const runtime = createWorkerRuntime(kshetra, { entrypoint: 'drain' });
    await runtime.startup();
    expect(await t.pglite.query<any>(`select count(*)::int n from pg_locks where locktype = 'advisory'`).then(r => r.rows[0].n)).toBe(1);

    expect(await runtime.scheduler.runCycle(kshetra, runtime.hooks)).toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
    expect(await t.pglite.query<any>(`select task_id, worker from taskgraph.attempts`).then(r => r.rows.map(({ task_id, worker }) => ({ task_id, worker }))))
      .toEqual([{ task_id: task.id, worker: expect.stringMatching(/\/\d+$/) }]);

    // Finishing through the engine lands with merge (T4.5): until then a run that
    // doesn't move its task gives the claim back.
    expect(await t.pglite.query<any>(`select outcome from taskgraph.attempts`).then(r => r.rows)).toEqual([{ outcome: 'release' }]);
    await runtime.close();
  });

  it('refuses a Kshetra with no project (still on beads), naming shreni migrate', async () => {
    const { workerPreconditionError } = await import('./worker-runtime');
    const { kshetra } = await setup();
    const { project: _p, ...unmigrated } = kshetra as KshetraConfig & { project?: string };
    expect(workerPreconditionError(unmigrated as KshetraConfig, false)).toBe('web has no task graph project: run shreni migrate web');
    // With a project it is clear to run (credentials aside).
    expect(workerPreconditionError(kshetra, false) ?? '').not.toMatch(/shreni migrate/);
  });
});
