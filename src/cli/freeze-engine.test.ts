import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import { exportShreniProject, importShreniProject, type ShreniBundle } from '../policy/db/bundle';
import type { KshetraConfig } from '../kshetra/config';

// Freeze, restore and report on the task graph engine (migration plan, "Beyond
// the bd wrapper"): the snapshot is the project's export, its version the last
// event id; restore is a purge, then an import; the report's waiting-on-human
// time comes from events; the ledger sits in the runtime dir.

const HOME = mkdtempSync(join(tmpdir(), 'shreni-engine-home-'));
vi.mock('os', async orig => ({ ...(await orig<typeof import('os')>()), homedir: () => HOME }));
let registry: KshetraConfig[] = [];
vi.mock('../kshetra/registry', async orig => ({ ...(await orig<object>()), loadRegistry: () => registry }));
let shreni: ShreniClient;
let unreachable = false;
vi.mock('../policy/sthapathi/connect', () => ({
  openKshetraEngine: async () => {
    if (unreachable) throw new Error('connect ECONNREFUSED');
    return { shreni, close: async () => {} };
  },
}));

const { runFreeze } = await import('./freeze');
const { runRestore } = await import('./restore');
const { runReport } = await import('./report');
const { makeContext } = await import('./registry');
const { ledgerPath, kshetraDir } = await import('../kshetra/state-locations');
const { collectBeads } = await import('../sthapathi/lot-manifest');
const { takeWorkerLock } = await import('../policy/sthapathi/leases');
const { BEADS_INTERACTION_EVENT, engineReads } = await import('../policy/sthapathi/reads');

const ACTOR = { id: 'ann', role: 'developer' };

async function setup() {
  const t = await createTestDb();
  shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: ACTOR });
  const tg = shreni.tg.project(p.id);
  const id = `web-${Math.random().toString(36).slice(2, 8)}`;
  const work = mkdtempSync(join(tmpdir(), 'shreni-engine-work-'));
  const kshetra = {
    id, name: 'web', project: p.id, database: 'local',
    repo: { path: work, remote: '', mainBranch: 'main' }, beads: { path: join(work, 'no-beads') }, stack: { language: 'ts' },
  } as unknown as KshetraConfig;
  registry = [kshetra];
  unreachable = false;
  return { t, tg, kshetra, p };
}

const quiet = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
};

describe('freeze and restore on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('a restored Kshetra\'s tasks and events (and Shreni rows) match the freeze', async () => {
    const { tg, kshetra, p } = await setup();
    quiet();
    const sys = tg.as({ id: 's', role: 'system' });
    const orc = tg.as({ id: 'o', role: 'orchestrator' });
    const a = await sys.tasks.create({ title: 'a' });
    await orc.notes.add(a.id, 'Round 1: dispatching silpi');
    await shreni.transaction(db => db.insertInto('shreni.memories').values({ project_id: p.id, key: 'k', content: 'c' }).execute());
    const frozen = await exportShreniProject(shreni, p.id);

    const out = mkdtempSync(join(tmpdir(), 'shreni-engine-snap-'));
    await runFreeze(makeContext(['--kshetra', kshetra.id, '--out', out]));
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.engine).toMatchObject({ projectId: p.id, lastEventId: expect.stringMatching(/^\d+$/), snapshotPath: 'engine.json' });
    expect(manifest.beads).toMatchObject({ beadCount: 1, memoryCount: 1, headSha: null });
    expect(manifest.locations.map((l: { key: string }) => l.key)).not.toContain('beads');
    // The ledger is in the runtime dir now, beside activity.jsonl.
    expect(ledgerPath(kshetra)).toBe(join(kshetraDir(kshetra.id), 'ledger.jsonl'));
    expect(readFileSync(ledgerPath(kshetra), 'utf8')).toMatch(/"state_frozen".*"lastEventId"/);

    // Work moves on after the freeze...
    await orc.moveClaimed((await orc.claim({ worker: 'w', leaseMs: 60_000 }))!, 'finish');
    await sys.tasks.create({ title: 'b' });
    await shreni.transaction(db => db.deleteFrom('shreni.memories').execute());

    // ...and the restore puts the frozen project back.
    await runRestore(makeContext(['--kshetra', kshetra.id, '--from', out, '--yes']));
    const after = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id)));
    after.engine.events = after.engine.events.filter((e: { kind: string }) => e.kind !== 'project.imported');
    expect(after).toEqual(JSON.parse(JSON.stringify(frozen)));
    expect(readFileSync(ledgerPath(kshetra), 'utf8')).toMatch(/"state_restored"/);
  });

  it('refuses to cross a beads snapshot onto an engine Kshetra', async () => {
    const { kshetra } = await setup();
    const out = mkdtempSync(join(tmpdir(), 'shreni-engine-snap-'));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, snapshotId: 'x', kshetraId: kshetra.id, createdAt: '', locations: [], labels: {},
      beads: { headSha: null, lastDoltCommit: null, beadCount: 0, memoryCount: 0, openCount: 0, closedCount: 0, beadIdHash: '' },
      rag: { present: false, sizeBytes: 0 }, shreniBuild: {}, repoPath: '',
    }));
    const archive = join(mkdtempSync(join(tmpdir(), 'shreni-engine-arch-')), 'a');
    await expect(runRestore(makeContext(['--kshetra', kshetra.id, '--from', out, '--yes', '--archive', archive]))).rejects.toThrow(/beads directory/);
    // Refused before anything was archived.
    expect(existsSync(archive)).toBe(false);
  });

  /** A Kshetra with one task, frozen; returns the snapshot dir and its bundle. */
  async function frozenKshetra() {
    const env = await setup();
    quiet();
    await env.tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    const out = mkdtempSync(join(tmpdir(), 'shreni-engine-snap-'));
    await runFreeze(makeContext(['--kshetra', env.kshetra.id, '--out', out]));
    const restoreArgs = (extra: string[] = []) => makeContext(['--kshetra', env.kshetra.id, '--from', out, '--yes', ...extra]);
    const bundle = () => JSON.parse(readFileSync(join(out, 'engine.json'), 'utf8')) as ShreniBundle;
    const rewrite = (b: ShreniBundle) => writeFileSync(join(out, 'engine.json'), JSON.stringify(b));
    return { ...env, out, restoreArgs, bundle, rewrite };
  }

  it('writes an engine manifest as schema version 2, so older builds refuse it', async () => {
    const { out } = await frozenKshetra();
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).schemaVersion).toBe(2);
  });

  it('records the restored project\'s last event id in state_restored', async () => {
    const { kshetra, p, restoreArgs } = await frozenKshetra();
    await runRestore(restoreArgs());
    const restored = readFileSync(ledgerPath(kshetra), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.kind === 'state_restored');
    expect(restored.payload.lastEventId).toBe(await engineReads(shreni, shreni.tg.project(p.id)).lastEventId());
  });

  it('refuses a snapshot on another lifecycle version before purging anything', async () => {
    const { tg, restoreArgs, bundle, rewrite } = await frozenKshetra();
    const b = bundle();
    b.engine.project.lifecycleVersion = 99;
    rewrite(b);
    await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'after the freeze' });
    await expect(runRestore(restoreArgs())).rejects.toThrow(/lifecycle/);
    expect((await tg.tasks.list({})).map(t => t.title).sort()).toEqual(['a', 'after the freeze']);
  });

  it('refuses Shreni rows from another schema before purging anything', async () => {
    const { tg, p, restoreArgs, bundle, rewrite } = await frozenKshetra();
    const b = bundle();
    b.shreni.memories = [{ project_id: p.id, key: 'k', content: 'c', a_column_from_elsewhere: 1 }];
    rewrite(b);
    await expect(runRestore(restoreArgs())).rejects.toThrow(/columns/);
    expect(await tg.tasks.list({})).toHaveLength(1);
  });

  it('puts the live project back when the import fails after the purge', async () => {
    const { tg, restoreArgs, bundle, rewrite } = await frozenKshetra();
    const b = bundle();
    // Passes the pre-checks; the engine refuses it inside the import.
    b.engine.deps = [{ taskId: b.engine.tasks[0].id, dependsOnId: 'web-404' }];
    rewrite(b);
    await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'after the freeze' });
    await expect(runRestore(restoreArgs())).rejects.toThrow(/live one was put back/);
    expect((await tg.tasks.list({})).map(t => t.title).sort()).toEqual(['a', 'after the freeze']);
  });

  it('refuses to restore, or to freeze without --force, while a worker holds the lock', async () => {
    const { kshetra, tg, out, restoreArgs } = await frozenKshetra();
    const release = await takeWorkerLock(tg);
    onTestFinished(() => release());
    await expect(runRestore(restoreArgs())).rejects.toThrow(/another worker already runs/);
    const again = mkdtempSync(join(tmpdir(), 'shreni-engine-snap-'));
    await expect(runFreeze(makeContext(['--kshetra', kshetra.id, '--out', again]))).rejects.toThrow(/another worker already runs/);
    await runFreeze(makeContext(['--kshetra', kshetra.id, '--out', again, '--force']));
    expect(existsSync(join(again, 'engine.json'))).toBe(true);
    expect(existsSync(join(out, 'engine.json'))).toBe(true);
  });
});

describe('the report and lot manifests on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('waiting-on-human time comes from events: an escalation until the developer acts', async () => {
    const { t, tg, kshetra } = await setup();
    const a = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    await tg.as({ id: 'o', role: 'orchestrator' }).move(a.id, 'flag', { reason: 'escalated' });
    await tg.as({ id: 'dev', role: 'developer' }).move(a.id, 'unblock');
    const acted = new Date((await t.pglite.query<any>(`select max(at) at from taskgraph.events where actor_role = 'developer'`)).rows[0].at).getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const dir = kshetraDir(kshetra.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'activity.jsonl'), [
      { ts: iso(acted - 3 * 3600_000), lotId: 'lot-1', schemaVersion: 1, type: 'worker_started', kshetra: kshetra.id, entrypoint: 'worker', subject: {}, process: {}, labels: {} },
      { ts: iso(acted), lotId: 'lot-1', schemaVersion: 1, type: 'phase_changed', kshetra: kshetra.id, from: 'IDLE', to: 'SELECTING', heldMs: 7200_000, polls: 240 },
      { ts: iso(acted), lotId: 'lot-1', schemaVersion: 1, type: 'task_done', kshetra: kshetra.id, beadId: a.id, title: 'a', approved: true, rounds: 1 },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(dir, 'notifications.jsonl'),
      JSON.stringify({ ts: iso(acted - 2 * 3600_000), event: 'pr_followup_escalated', beadId: a.id, message: 'escalated' }) + '\n');
    const log = quiet();
    await runReport({ args: [`@${kshetra.id}`], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra], json: true });
    const metrics = JSON.parse(log.mock.calls[0][0] as string);
    expect(metrics.lots[0].waitingOnHumanMs).toBe(2 * 3600_000);
  });

  it('counts interactions the beads importer kept, whatever their actor\'s role', async () => {
    const { tg, p } = await setup();
    const a = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    const b = JSON.parse(JSON.stringify(await exportShreniProject(shreni, p.id))) as ShreniBundle;
    b.engine.events.push({
      taskId: a.id, planId: null, attemptId: null, kind: BEADS_INTERACTION_EVENT, actor: 'beads-importer', actorRole: 'system',
      fromState: null, toState: null, payload: { kind: 'comment' }, requestId: null, at: new Date('2026-01-01T00:00:00Z'),
    } as ShreniBundle['engine']['events'][number]);
    await shreni.tg.projects.purge(p.id, { actor: ACTOR, confirmName: 'web' });
    await importShreniProject(shreni, b, { actor: { id: 'shreni', role: 'system' } });
    const got = await engineReads(shreni, shreni.tg.project(p.id)).interactions();
    expect(got).toEqual([{ created_at: '2026-01-01T00:00:00.000Z', issue_id: a.id, kind: BEADS_INTERACTION_EVENT, actor: 'beads-importer' }]);
  });

  it('prints the report without the database, saying waiting-on-human is unknown', async () => {
    const { kshetra } = await setup();
    const dir = kshetraDir(kshetra.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'activity.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), lotId: 'lot-1', schemaVersion: 1, type: 'worker_started', kshetra: kshetra.id,
      entrypoint: 'worker', subject: {}, process: {}, labels: {},
    }) + '\n');
    unreachable = true;
    const log = quiet();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => err.mockRestore());
    await runReport({ args: [`@${kshetra.id}`], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra], json: true });
    expect(JSON.parse(log.mock.calls[0][0] as string).lots).toHaveLength(1);
    expect(err.mock.calls.join('\n')).toMatch(/waiting-on-human is unknown.*ECONNREFUSED/);
  });

  it('a lot manifest records an unreadable database as an error, not as an empty project', async () => {
    const { kshetra, p } = await setup();
    unreachable = true;
    expect(await collectBeads(kshetra)).toEqual({ engine: { projectId: p.id, lastEventId: null, error: expect.stringMatching(/ECONNREFUSED/) } });
  });

  it('a lot manifest records the project\'s last event id', async () => {
    const { tg, kshetra, p } = await setup();
    await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    expect(await collectBeads(kshetra)).toEqual({ engine: { projectId: p.id, lastEventId: expect.stringMatching(/^\d+$/) } });
  });
});
