import { describe, it, expect, vi, onTestFinished, beforeEach } from 'vitest';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { engineTaskStore } from './task-store';
import { EngineQueue } from './leases';
import { engineHooks } from './hooks';
import { registerEngineStore, unregisterEngineStore } from '../../sthapathi/task-store';
import type { KshetraConfig } from '../../kshetra/config.js';
import type { Claim } from '../../taskgraph';

// Merge and PR follow-up on the engine (policy spec, "The lifecycle", "Boost
// and repeated expiry"). gh and git are stubbed; the engine and Shreni's
// tables are real (PGlite).

const pr = { state: 'OPEN' as 'OPEN' | 'MERGED' | 'CLOSED', url: 'https://github.com/o/r/pull/7' };
const status = { reviews: [] as unknown[], checks: [], commits: [] };
vi.mock('../../sthapathi/gh.js', () => ({
  gh: () => ({ prView: async () => ({ ...pr }), prStatus: async () => ({ ...pr, ...status }) }),
}));
vi.mock('../../sthapathi/git.js', () => ({
  git: () => ({
    deleteBranch: async () => {}, push: async () => {}, checkout: async () => {}, merge: async () => {},
    commit: async () => {}, headSha: async () => 'abc',
  }),
}));
vi.mock('../../sthapathi/parikshaka-dispatch.js', () => ({ dispatchParikshakaAsync: () => {} }));
vi.mock('../../sthapathi/repo-map.js', async orig => ({ ...(await orig<object>()), regenerateRepoMapAsync: () => {} }));

/** The production rule (worker-runtime): boosted, with a PR on an earlier attempt. */
const followupCheck = (rows: (q: string, p?: unknown[]) => Promise<any[]>) => async (t: { id: string; boosted: boolean }) =>
  t.boosted && (await rows(`select 1 from taskgraph.attempts a join shreni.attempt_evidence e on e.attempt_id = a.id where a.task_id = $1 and e.pr_url is not null`, [t.id])).length > 0;
beforeEach(() => { pr.state = 'OPEN'; status.reviews = []; });

const kshetra = {
  id: 'web', repo: { path: '/r', mainBranch: 'main', mergePolicy: 'pr', prFollowup: true, prFollowupSelfLogins: [], prFollowupRequiredChecks: [] },
} as unknown as KshetraConfig;

async function setup() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { unregisterEngineStore(kshetra.id); await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  const as = tg.as({ id: 'sthapathi', role: 'orchestrator' });
  const claims = new Map<string, Claim>();
  const store = engineTaskStore({ shreni, tg, as, claimFor: id => claims.get(id) });
  registerEngineStore(kshetra.id, store);
  const rows = async (q: string, params: unknown[] = []) => (await t.pglite.query<any>(q, params)).rows;
  return { shreni, tg, as, claims, store, rows, sys: tg.as({ id: 's', role: 'system' }) };
}

describe('the engine task store', { timeout: PGLITE_TIMEOUT }, () => {
  it('opening a PR records it and submits: the task is waiting', async () => {
    const { as, claims, store, sys, rows } = await setup();
    const t = await sys.tasks.create({ title: 'Add login' });
    const c = (await as.claim({ worker: 'w', leaseMs: 60_000 }))!;
    claims.set(t.id, c);
    await store.beforeMerge(t.id);
    await store.deferForPr(t.id, pr.url);
    expect(await rows(`select state from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'waiting' }]);
    expect(await rows(`select pr_url from shreni.attempt_evidence`)).toEqual([{ pr_url: pr.url }]);
  });

  it('new review comments reopen it boosted, claimed ahead of higher-priority work as a follow-up; the merge finishes it', async () => {
    const { as, claims, store, sys, rows, tg } = await setup();
    const t = await sys.tasks.create({ title: 'Add login', priority: 3 });
    const c = (await as.claim({ worker: 'w', leaseMs: 60_000 }))!;
    claims.set(t.id, c);
    await store.deferForPr(t.id, pr.url);
    claims.delete(t.id);
    await sys.tasks.create({ title: 'urgent', priority: 0 });

    // reconcile sees a review asking for changes
    status.reviews = [{ author: 'reviewer', state: 'CHANGES_REQUESTED', body: 'rename it', submittedAt: new Date().toISOString(), comments: [] }];
    const { reconcilePullRequests } = await import('../../sthapathi/merge.js');
    await reconcilePullRequests(kshetra);
    expect(await rows(`select state, boosted from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'open', boosted: true }]);

    const hooks = engineHooks({
      queue: new EngineQueue(tg, as, 'w'), preflight: async () => {}, run: async () => {}, onUnavailable: () => {},
      isFollowup: followupCheck(rows),
    });
    const claimed = (await hooks.prepareTask({} as never, kshetra))!;
    expect(claimed).toMatchObject({ id: t.id, followup: true });

    // the round pushes and goes back to waiting on the PR, its watermark on the evidence
    claims.set(t.id, hooks.claims.get(t.id)!);
    await store.writeWatermark(t.id, { head: 'abc', round: 1, at: 'now' });
    await store.resubmit(t.id, 'follow-up pushed');
    expect(await rows(`select state from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'waiting' }]);
    expect(await store.readWatermark(t.id)).toEqual({ head: 'abc', round: 1, at: 'now' });
    claims.delete(t.id);

    // the human merges
    pr.state = 'MERGED';
    await reconcilePullRequests(kshetra);
    expect(await rows(`select state from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'done' }]);
  });

  it('a PR closed unmerged flags the task for a human', async () => {
    const { as, claims, store, sys, rows } = await setup();
    const t = await sys.tasks.create({ title: 't' });
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    await store.deferForPr(t.id, pr.url);
    claims.delete(t.id);
    pr.state = 'CLOSED';
    const { reconcilePullRequests } = await import('../../sthapathi/merge.js');
    await reconcilePullRequests(kshetra);
    expect(await rows(`select state from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'blocked' }]);
  });

  it('push mode finishes the claimed task, fenced by its claim', async () => {
    const { as, claims, store, sys, rows } = await setup();
    const t = await sys.tasks.create({ title: 't' });
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    await store.beforeMerge(t.id);
    await store.finish(t.id, 'Merged');
    expect(await rows(`select state from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'done' }]);
    expect(await rows(`select outcome from taskgraph.attempts`)).toEqual([{ outcome: 'finish' }]);
  });
});

describe('review follow-ups (T4.5)', { timeout: PGLITE_TIMEOUT }, () => {
  it('a follow-up whose branch can\'t be prepared goes back to waiting, not to the head of the queue', async () => {
    const { as, claims, store, sys, rows, tg } = await setup();
    const t = await sys.tasks.create({ title: 'Add login' });
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    await store.deferForPr(t.id, pr.url);
    claims.delete(t.id);
    await store.needsFollowup(t.id);
    const hooks = engineHooks({
      queue: new EngineQueue(tg, as, 'w'), run: async () => {}, onUnavailable: () => {},
      preflight: async () => { throw new Error('branch gone'); },
      isFollowup: followupCheck(rows),
      onFollowupRefused: id => store.resubmit(id, 'branch gone'),
    });
    expect(await hooks.prepareTask({} as never, kshetra)).toBeNull();
    expect(await rows(`select state, boosted from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'waiting', boosted: false }]);
  });

  it('a task whose PR was closed, once unblocked, is worked afresh, not as a follow-up', async () => {
    const { as, claims, store, sys, rows, tg } = await setup();
    const t = await sys.tasks.create({ title: 't' });
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    await store.deferForPr(t.id, pr.url);
    claims.delete(t.id);
    await store.prDeclined(t.id, 'closed');
    await tg.as({ id: 'd', role: 'developer' }).move(t.id, 'unblock');
    const hooks = engineHooks({ queue: new EngineQueue(tg, as, 'w'), run: async () => {}, onUnavailable: () => {}, preflight: async () => {}, isFollowup: followupCheck(rows) });
    expect(await hooks.prepareTask({} as never, kshetra)).toMatchObject({ id: t.id });
    expect((await hooks.prepareTask({} as never, kshetra))).toBeNull();
    const again = await rows(`select count(*)::int n from taskgraph.attempts where task_id = $1`, [t.id]);
    expect(again).toEqual([{ n: 2 }]);
    expect([...hooks.claims.values()][0]).toBeDefined();
    const claimed = [...hooks.claims.keys()][0];
    expect(claimed).toBe(t.id);
  });

  it('a merge whose finish is refused flags the task rather than reopening it', async () => {
    const { as, claims, sys, rows, shreni, tg } = await setup();
    const t = await sys.tasks.create({ title: 'Checked task' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: t.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute());
    claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000 }))!);
    const { squashMergeAndClose } = await import('../../sthapathi/merge.js');
    await squashMergeAndClose({ id: t.id, slug: 'checked-task', title: 'Checked task', status: 'in_progress', priority: 2 },
      { ...kshetra, repo: { ...kshetra.repo, mainBranch: 'main' } } as KshetraConfig,
      { summary: 's', filesChanged: [], confidenceScore: 0.9, questionsForReviewer: [] } as never);
    expect(await rows(`select state from taskgraph.tasks where id = $1`, [t.id])).toEqual([{ state: 'blocked' }]);
  });

  it('reconcile keeps going past a task it can\'t settle', async () => {
    const { as, claims, store, sys, rows, shreni, tg } = await setup();
    const a = await sys.tasks.create({ title: 'a' });
    const b = await sys.tasks.create({ title: 'b' });
    for (const t of [a, b]) {
      claims.set(t.id, (await as.claim({ worker: 'w', leaseMs: 60_000, filter: { ids: [t.id] } }))!);
      await store.deferForPr(t.id, pr.url);
      claims.delete(t.id);
    }
    // a has a check that never passed: its finish is refused
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: a.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute());
    pr.state = 'MERGED';
    const { reconcilePullRequests } = await import('../../sthapathi/merge.js');
    await reconcilePullRequests(kshetra);
    expect(await rows(`select id, state from taskgraph.tasks order by created_at`)).toEqual([{ id: a.id, state: 'waiting' }, { id: b.id, state: 'done' }]);
  });
});
