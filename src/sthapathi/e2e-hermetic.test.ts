/**
 * Tier 1 — hermetic integration harness (Shreni-beads-k3n.2), on the task graph engine.
 *
 * Exercises the REAL git binary end-to-end in throwaway tmp repos, and the real
 * task graph engine (PGlite), driving the actual orchestration path:
 *
 *     file (system) → selectNext (peek) → prepareTask (claim + real git
 *       preflight) → runTask: createTaskBranch → [stubbed agent diff, really
 *       committed] → squashMergeAndClose (real squash-merge to main + finish)
 *
 * The ONLY thing synthesized is the agent/LLM turn: instead of running
 * Silpi↔Viharapala we hand-build the diff (a real commit on the task branch)
 * and a SilpiOutput. Everything at the engine/git seam runs for real — no
 * vi.mock on git.js or the task store — so drift in git's squash-merge
 * behaviour, or in the claim → finish path, surfaces here as a red test.
 *
 * Deterministic and secret-free: it stubs only the two post-merge side effects
 * that would otherwise reach outward (the Parikshaka test agent and the
 * repo-map regeneration) and uses stack.language 'unknown' so the health/lint
 * gates skip cleanly.
 */

import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KshetraConfig } from '../kshetra/config.js';
import type { SilpiOutput, Task } from './types.js';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import { engineTaskStore } from '../policy/sthapathi/task-store';
import { engineHooks } from '../policy/sthapathi/hooks';
import { EngineQueue } from '../policy/sthapathi/leases';
import { registerEngineStore, unregisterEngineStore } from './task-store.js';

// The post-merge test agent and the repo-map refresh are fire-and-forget side
// effects of squashMergeAndClose — NOT part of the seam under test, and the
// former would try to spawn a real provider CLI. Stub them to no-ops so the
// merge path stays hermetic. The merge itself (git checkout/merge/commit/push/
// branch -D) runs for real via the un-mocked git.js.
vi.mock('./parikshaka-dispatch.js', () => ({ dispatchParikshakaAsync: vi.fn() }));
vi.mock('../kshetra/repo-map.js', () => ({
  regenerateRepoMapAsync: vi.fn(),
  loadRepoMap: vi.fn(async () => ''),
  REPO_MAP_RELATIVE_PATH: '.shreni/repo-map.md',
}));

import { preFlightFresh, toSlug } from './pickup.js';
import { createTaskBranch, branchName } from './branch.js';
import { squashMergeAndClose } from './merge.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A working clone with main pushed to a bare origin, so the real pull/push has a remote. */
function fixtureRepo(root: string): { repo: string; origin: string } {
  const origin = join(root, 'code-origin.git');
  const repo = join(root, 'repo');
  git(root, 'init', '--bare', '-q', origin);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'e2e@shreni.test');
  git(repo, 'config', 'user.name', 'shreni-e2e');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'README.md'), '# hermetic fixture\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { repo, origin };
}

describe('hermetic e2e on the engine: claim → branch → real squash-merge → finish', { timeout: PGLITE_TIMEOUT }, () => {
  it('claims a filed task, branches, squash-merges a stubbed diff to main, and finishes the task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shreni-e2e-'));
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => {
      unregisterEngineStore('hermetic');
      await shreni.close();
      await t.close();
      rmSync(root, { recursive: true, force: true });
    });
    await shreni.migrate();
    const p = await shreni.tg.projects.create({ name: 'hermetic', idPrefix: 'e2e', actor: { id: 'a', role: 'developer' } });
    const tg = shreni.tg.project(p.id);
    const { repo, origin } = fixtureRepo(root);

    // stack.language 'unknown' → the toolchain profile has no test/lint/build
    // command, so the health and lint gates skip-and-pass (see toolchain.ts).
    const kshetra = {
      id: 'hermetic', name: 'Hermetic', project: p.id, database: 'local', plan: { validators: {} },
      repo: { path: repo, remote: origin, mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
      stack: { language: 'unknown' },
      conventions: {},
      agents: { provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
      priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
    } as unknown as KshetraConfig;

    // The worker's wiring, as worker-runtime builds it.
    const as = tg.as({ id: 'sthapathi:hermetic', role: 'orchestrator' });
    const queue = new EngineQueue(tg, as, 'e2e-worker');
    let merged: Task | undefined;
    const hooks = engineHooks({
      queue,
      preflight: (task, k) => preFlightFresh(task, k),
      onUnavailable: () => { throw new Error('the database is in-process; it never goes away'); },
      run: async (task, k) => {
        // ── BRANCH: real createTaskBranch off main ────────────────────────────
        const branch = await createTaskBranch(task, k);
        expect(branch).toBe(branchName(task));
        expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
        // ── STUB the agent turn: a real commit on the task branch ─────────────
        writeFileSync(join(repo, 'src-fix.txt'), 'the login bug is fixed\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-qm', 'agent: fix login bug');
        const silpiOut: SilpiOutput = {
          filesChanged: [{ path: 'src-fix.txt', diff: '+the login bug is fixed' }],
          testFiles: [],
          summary: 'Fixed the login bug',
          confidenceScore: 95,
          questionsForReviewer: [],
          lintPassed: true,
          testsPassed: true,
          insights: [],
        };
        // ── MERGE + FINISH: the real squash-merge path ────────────────────────
        await store.recordAcceptance(task.id, true);
        await squashMergeAndClose(task, k, silpiOut);
        merged = task;
      },
    });
    const store = engineTaskStore({
      shreni, tg, as,
      systemActor: tg.as({ id: 'sthapathi:hermetic', role: 'system' }),
      agentActor: tg.as({ id: 'parikshaka', role: 'agent' }),
      claimFor: id => hooks.claims.get(id),
      onClaimEnded: id => hooks.endClaim(id),
    });
    registerEngineStore(kshetra.id, store);

    // The single unit of work — filed as system, so it lands open.
    const filed = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'Fix login bug', priority: 2 });

    // ── SELECT: read-only peek → the ready task ─────────────────────────────
    const selected = await hooks.selectNext(kshetra);
    expect(selected?.id).toBe(filed.id);
    expect(selected!.slug).toBe(toSlug('Fix login bug'));

    // ── PREPARE: claim + real preflight (checkout main, pull, branch guard) ──
    const prepared = await hooks.prepareTask(selected!, kshetra);
    expect(prepared?.id).toBe(filed.id);
    expect((await tg.tasks.get(filed.id))?.state).toBe('claimed');

    // ── WORK: branch, commit, squash-merge, finish ──────────────────────────
    await hooks.runTask(prepared!, kshetra);
    expect(merged?.id).toBe(filed.id);

    // main really advanced and carries the agent's file, as a squash…
    git(repo, 'checkout', '-q', 'main');
    expect(existsSync(join(repo, 'src-fix.txt')), 'the fix file should be present on main').toBe(true);
    const mainLog = git(repo, 'log', '--oneline', '-1');
    expect(mainLog).toContain(filed.id);
    expect(mainLog).toContain('Fix login bug');
    // …the squashed change is really on the remote origin/main…
    expect(git(repo, 'rev-parse', 'origin/main').trim()).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    // …the merged branch was force-deleted…
    expect(git(repo, 'branch', '--list', branchName(prepared!)).trim()).toBe('');
    // …and the engine finished the task, which leaves the ready queue empty.
    expect((await tg.tasks.get(filed.id))?.state).toBe('done');
    expect(await hooks.selectNext(kshetra)).toBeNull();
  });
});
