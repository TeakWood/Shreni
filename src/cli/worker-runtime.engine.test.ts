import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import type { KshetraConfig } from '../kshetra/config';

// The worker runtime in engine mode (policy spec, "Running work"): a Kshetra
// whose kshetra.yaml names its engine project is worked through the engine,
// never through bd. Git, the agents and the lot manifest are stubbed.

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
    ...real, selectNext: vi.fn(), prepareTask: vi.fn(),
    preFlightFresh: async (task: never, k: never) => { if (!(await real.healthGate(task, k))) throw new real.BaseRedError(task); },
  };
});
vi.mock('../sthapathi/beads', async orig => ({ ...(await orig<object>()), syncBeads: vi.fn() }));
vi.mock('../sthapathi/lot-manifest', async orig => ({ ...(await orig<object>()), collectLotManifest: async () => ({}) }));
vi.mock('../ext/loader', async orig => ({ ...(await orig<object>()), loadExtension: async () => false }));

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
    beads: { path: dir, remote: 'x', mode: 'embedded' }, stack: { language: 'ts' },
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

  it('claims and runs through the engine, takes the worker lock, and never touches bd', async () => {
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
      beads: { path: dir, remote: 'x', mode: 'embedded' }, stack: { language: 'ts' },
      gates: { build: { level: 'block' }, test: { level: 'block' }, lint: { level: 'warn' } },
      agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 }, priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
      conventions: {},
    } as unknown as KshetraConfig;

    const { createWorkerRuntime } = await import('./worker-runtime');
    const pickup = await import('../sthapathi/pickup');
    const beads = await import('../sthapathi/beads');
    const runtime = createWorkerRuntime(kshetra, { entrypoint: 'drain' });
    await runtime.startup();
    expect(await t.pglite.query<any>(`select count(*)::int n from pg_locks where locktype = 'advisory'`).then(r => r.rows[0].n)).toBe(1);

    expect(await runtime.scheduler.runCycle(kshetra, runtime.hooks)).toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
    expect(await t.pglite.query<any>(`select task_id, worker from taskgraph.attempts`).then(r => r.rows.map(({ task_id, worker }) => ({ task_id, worker }))))
      .toEqual([{ task_id: task.id, worker: expect.stringMatching(/\/\d+$/) }]);
    expect(pickup.selectNext).not.toHaveBeenCalled();
    expect(pickup.prepareTask).not.toHaveBeenCalled();
    expect(beads.syncBeads).not.toHaveBeenCalled();

    // Finishing through the engine lands with merge (T4.5): until then a run that
    // doesn't move its task gives the claim back.
    expect(await t.pglite.query<any>(`select outcome from taskgraph.attempts`).then(r => r.rows)).toEqual([{ outcome: 'release' }]);
    await runtime.close();
  });
});
