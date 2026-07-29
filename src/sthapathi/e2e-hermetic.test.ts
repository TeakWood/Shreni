/**
 * Tier 1 — hermetic integration harness (Shreni-beads-k3n.2).
 *
 * Replaces the old, misnamed src/cli/e2e-pickup.test.ts, which mocked beads.js
 * and git.js and so re-checked nothing about the real external tools. This test
 * exercises the REAL bd and git binaries end-to-end in throwaway tmp repos and
 * drives the actual orchestration path:
 *
 *     bd create → selectNext (bd ready) → prepareTask (claim, in_progress)
 *       → createTaskBranch (branch off main) → [stubbed agent diff, really
 *       committed] → squashMergeAndClose (real squash-merge to main + bd close)
 *
 * The ONLY thing synthesized is the agent/LLM turn: instead of running
 * Silpi↔Viharapala we hand-build the diff (a real commit on the bead branch)
 * and a SilpiOutput. Everything at the bd/git seam runs for real — no vi.mock
 * on beads.js or git.js — so contract drift in bd's `ready`/`show --json`
 * output, its flags, or git's squash-merge behaviour surfaces here as a red
 * test rather than shipping green.
 *
 * Deterministic and secret-free: it stubs only the two post-merge side effects
 * that would otherwise reach outward (the Parikshaka test agent and the
 * repo-map regeneration) and uses stack.language 'unknown' so the health/lint
 * gates skip cleanly. Skips itself with a clear message when bd is not on PATH.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KshetraConfig } from '../kshetra/config.js';
import type { SilpiOutput } from './types.js';

// The post-merge test agent and the repo-map refresh are fire-and-forget side
// effects of squashMergeAndClose — NOT part of the bd/git seam under test, and
// the former would try to spawn a real provider CLI. Stub them to no-ops so the
// merge path stays hermetic. The merge itself (git checkout/merge/commit/push/
// branch -D) runs for real via the un-mocked git.js.
vi.mock('./parikshaka-dispatch.js', () => ({ dispatchParikshakaAsync: vi.fn() }));
vi.mock('../kshetra/repo-map.js', () => ({
  regenerateRepoMapAsync: vi.fn(),
  loadRepoMap: vi.fn(async () => ''),
}));

import { selectNext, prepareTask, toSlug } from './pickup.js';
import { createTaskBranch, branchName } from './branch.js';
import { squashMergeAndClose } from './merge.js';

// ── skip guard: bd must be installed ─────────────────────────────────────────

function bdInstalled(): boolean {
  try {
    execFileSync('bd', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const BD = bdInstalled();

// ── thin fixture helpers (setup only — the SUT drives the real orchestration) ─

// vitest wraps process.env in a proxy whose spread ({...process.env}) can drop
// PATH, so any spawn with an env override must re-add PATH explicitly or the
// binary lookup fails with ENOENT. Read the keys we care about directly.
function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// `bd init` must NOT carry a BEADS_DIR (it creates the .beads workspace under
// cwd); every other bd command targets that workspace via BEADS_DIR.
function bdInit(cwd: string, ...args: string[]): string {
  return execFileSync('bd', ['init', ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv({ BD_NON_INTERACTIVE: '1' }),
  });
}

function bd(beadsDir: string, ...args: string[]): string {
  return execFileSync('bd', args, {
    cwd: beadsDir,
    encoding: 'utf8',
    env: childEnv({ BEADS_DIR: beadsDir, BD_NON_INTERACTIVE: '1' }),
  });
}

// bd status of a single issue, read via the real `bd show --json` (a list).
function beadStatus(beadsDir: string, id: string): string {
  const parsed = JSON.parse(bd(beadsDir, 'show', id, '--json')) as { status: string }[];
  return parsed[0]?.status ?? '(missing)';
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!BD)('hermetic e2e: pickup → branch → real squash-merge → close', () => {
  let root: string;
  let repo: string; // working clone the orchestration operates on
  let beadsDir: string; // the `.beads` workspace = kshetra.beads.path
  let kshetra: KshetraConfig;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shreni-e2e-'));

    // Code repo: a bare origin + a working clone with main already pushed, so
    // the real pull/push in preFlightCheck, createTaskBranch and the merge have
    // a genuine remote to talk to.
    const codeOrigin = join(root, 'code-origin.git');
    repo = join(root, 'repo');
    git(root, 'init', '--bare', '-q', codeOrigin);
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'e2e@shreni.test');
    git(repo, 'config', 'user.name', 'shreni-e2e');
    git(repo, 'remote', 'add', 'origin', codeOrigin);
    writeFileSync(join(repo, 'README.md'), '# hermetic fixture\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'push', '-q', '-u', 'origin', 'main');

    // Beads repo: a git repo (syncBeads commits/pulls/pushes here) with a bare
    // origin, then `bd init` lays the real embedded-Dolt workspace into .beads/.
    const beadsRoot = join(root, 'beads');
    const beadsOrigin = join(root, 'beads-origin.git');
    git(root, 'init', '--bare', '-q', beadsOrigin);
    git(root, 'init', '-q', '-b', 'main', beadsRoot);
    git(beadsRoot, 'config', 'user.email', 'e2e@shreni.test');
    git(beadsRoot, 'config', 'user.name', 'shreni-e2e');
    git(beadsRoot, 'remote', 'add', 'origin', beadsOrigin);
    writeFileSync(join(beadsRoot, '.gitkeep'), '');
    git(beadsRoot, 'add', '-A');
    git(beadsRoot, 'commit', '-qm', 'init');
    git(beadsRoot, 'push', '-q', '-u', 'origin', 'main');
    bdInit(beadsRoot, '--prefix', 'e2e'); // creates beadsRoot/.beads
    beadsDir = join(beadsRoot, '.beads');

    // stack.language 'unknown' → the toolchain profile has no test/lint/build
    // command, so the health and lint gates skip-and-pass (see toolchain.ts).
    kshetra = {
      id: 'hermetic',
      name: 'Hermetic',
      repo: { path: repo, remote: codeOrigin, mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
      beads: { path: beadsDir, remote: beadsOrigin, mode: 'embedded' },
      stack: { language: 'unknown' },
      conventions: {},
      agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
      priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
    } as KshetraConfig;

    // The single unit of work — filed with the REAL bd create.
    bd(beadsDir, 'create', 'Fix login bug', '-p', '2', '-t', 'task');
  }, 120_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    'picks up a real bd task, branches, squash-merges a stubbed diff to main, and closes the bead',
    async () => {
      // ── SELECT: read-only bd ready → highest-priority ready task ────────────
      const task = await selectNext(kshetra);
      expect(task, 'selectNext should surface the bd-created task').not.toBeNull();
      expect(task!.title).toBe('Fix login bug');
      expect(task!.id).toMatch(/^e2e-/); // the real bd prefix we init'd with
      expect(task!.slug).toBe(toSlug('Fix login bug'));

      // ── PREPARE: real syncBeads + preflight + claim → in_progress ───────────
      const prepared = await prepareTask(task!, kshetra);
      expect(prepared, 'prepareTask should claim and return the task').not.toBeNull();
      expect(beadStatus(beadsDir, task!.id)).toBe('in_progress');

      // ── BRANCH: real createTaskBranch off main ──────────────────────────────
      const branch = await createTaskBranch(prepared!, kshetra);
      expect(branch).toBe(branchName(prepared!));
      expect(branch).toBe(`bead-${task!.id}/${task!.slug}`);
      // The branch really exists in the working repo…
      expect(git(repo, 'branch', '--list', branch)).toContain(branch);
      // …and HEAD is on it, ready for the agent turn.
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);

      // ── STUB the agent turn: a real commit on the bead branch ───────────────
      // This is the ONLY synthesized input. A genuine file change, git add +
      // commit — exactly what a Silpi round would leave behind — so the merge
      // path has real commits to squash.
      const fixPath = join(repo, 'src-fix.txt');
      writeFileSync(fixPath, 'the login bug is fixed\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'agent: fix login bug');
      const branchSha = git(repo, 'rev-parse', 'HEAD').trim();

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

      // ── MERGE + CLOSE: the real squash-merge path ───────────────────────────
      await squashMergeAndClose(prepared!, kshetra, silpiOut);

      // main really advanced and carries the agent's file…
      git(repo, 'checkout', '-q', 'main');
      expect(existsSync(fixPath), 'the fix file should be present on main').toBe(true);
      // …as a squash (a new commit, not the branch commit reachable as a parent).
      const mainSha = git(repo, 'rev-parse', 'HEAD').trim();
      expect(mainSha).not.toBe(branchSha);
      // squashMergeAndClose commits with buildCommitMessage: "<title> (<id>)".
      const mainLog = git(repo, 'log', '--oneline', '-1');
      expect(mainLog).toContain(task!.id);
      expect(mainLog).toContain('Fix login bug');

      // …the squashed change is really on the remote origin/main…
      const originSha = git(repo, 'rev-parse', 'origin/main').trim();
      expect(originSha).toBe(mainSha);

      // …the merged branch was force-deleted…
      expect(git(repo, 'branch', '--list', branch).trim()).toBe('');

      // …and bd really transitioned the task to closed.
      expect(beadStatus(beadsDir, task!.id)).toBe('closed');
      // A closed task is no longer in the ready pool.
      const afterClose = await selectNext(kshetra);
      expect(afterClose).toBeNull();
    },
    120_000,
  );
});

// Visible skip signal: when bd is absent the describe block above is skipped
// wholesale, but a bare `it.skipIf` keeps a named, self-documenting placeholder
// in the reporter so a skipped hermetic suite is never silent.
describe.skipIf(BD)('hermetic e2e (skipped — bd not on PATH)', () => {
  it.skip('requires the bd binary; install @beads/bd to run the hermetic integration suite', () => {
    /* skipped: bd not installed */
  });
});
