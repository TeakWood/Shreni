/**
 * Tier 2 — full end-to-end smoke against a REAL provider (Shreni-beads-k3n.4).
 *
 * Usage:  pnpm e2e:full            (requires `pnpm build` first + ANTHROPIC_API_KEY)
 *
 * The top of the test ladder. Tier 0 runs the mocked unit suite; Tier 1
 * (e2e-hermetic.test.ts) exercises the real bd+git seam but STUBS the LLM turn.
 * This tier stubs nothing: it drives one genuine Silpi ↔ Viharapala pass against
 * a live provider on a throwaway Kshetra with a single trivial task, and asserts
 * a real squash-merge to main + the bead closed. It is the only rung that
 * catches drift in the provider-CLI envelope (adapter parsing, tool-call shape,
 * the agent actually landing a usable diff), which no mock can.
 *
 * Nondeterministic and token-costing, so it is NOT a per-PR gate — the nightly
 * workflow (.github/workflows/e2e-nightly.yml) runs it on a schedule and alerts
 * on failure rather than blocking any branch.
 *
 * Everything is local: the fixture repo and the beads repo both push to bare
 * repos inside the workspace, so this needs no GitHub access — only the claude
 * CLI with credentials (ANTHROPIC_API_KEY), bd, and git. Absent the key it skips
 * cleanly with exit 0 so the workflow is green-when-unconfigured, not red.
 */
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { parseBeadIds, parseBeadStatus } from '../src/cert/assertions.js';
import { unregisterKshetra } from '../src/kshetra/registry.js';

const REPO_ROOT = resolve(__dirname, '..');
const SHRENI = join(REPO_ROOT, 'dist', 'cli', 'index.js');
// One trivial bead on a hosted runner is ~6-7 min of real agent latency; budget
// generously but hard-cap so a hung provider call can't run the job forever. The
// workflow's job timeout is the outer backstop.
const TIMEOUT_MS = Number(process.env['SHRENI_E2E_TIMEOUT_MS'] ?? 12 * 60_000);
const POLL_MS = 10_000;

// The single trivial unit of work. Language-agnostic on purpose: with
// stack.language 'unknown' the test/lint/build gates skip-and-pass, so the pass
// hinges only on the agent landing this file and the reviewer approving — the
// provider seam, not a toolchain. The assertion checks BOTH the bead closing and
// this exact file arriving on main.
const TASK_FILE = 'GREETING.txt';
const TASK_CONTENT = 'hello from shreni e2e';
const TASK_TITLE = `Add ${TASK_FILE} at the repo root`;
const TASK_DESC =
  `Create a file named ${TASK_FILE} at the root of the repository. ` +
  `It must contain exactly this single line of text:\n\n${TASK_CONTENT}\n\n` +
  `No other files or changes. Acceptance: ${TASK_FILE} exists at the repo root ` +
  `and its content is "${TASK_CONTENT}".`;

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

// A local bare repo standing in for GitHub: init-kshetra requires an origin
// remote and the merge path pushes main — the smoke must not touch a real forge.
function gitRepoWithLocalOrigin(dir: string, bareDir: string): void {
  mkdirSync(dir, { recursive: true });
  sh('git', ['init', '-b', 'main'], { cwd: dir });
  sh('git', ['init', '--bare', '-b', 'main', bareDir]);
  sh('git', ['remote', 'add', 'origin', bareDir], { cwd: dir });
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['commit', '--allow-empty', '-m', 'fixture: initial state'], { cwd: dir });
  sh('git', ['push', '-u', 'origin', 'main'], { cwd: dir });
}

async function main(): Promise<void> {
  // Skip-clean gate: no key, no run. Exit 0 so an unconfigured environment
  // (a fork, a secretless dispatch) reports green rather than a scary red.
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.log('⤳ SKIP: ANTHROPIC_API_KEY is not set — Tier 2 needs a real provider. Nothing run.');
    process.exit(0);
  }
  if (!existsSync(SHRENI)) {
    console.error(`Missing ${SHRENI} — run \`pnpm build\` first.`);
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), 'shreni-e2e-full-'));
  // Unique per run so concurrent/nightly invocations never collide in the
  // ~/.shreni registry or RAG dir. A plain counter is enough — the timestamp
  // keeps successive local runs distinct.
  const slug = `e2e-full-${Date.now()}`;
  const repoDir = join(work, 'repo');
  const beadsDir = join(work, 'beads');
  console.log(`▶ Tier 2 e2e in ${work} (kshetra ${slug})`);

  let worker: ReturnType<typeof spawn> | undefined;
  let registered = false;
  try {
    // 1. Fixture repo + beads repo, both wired to local bare origins.
    gitRepoWithLocalOrigin(repoDir, join(work, 'repo-origin.git'));
    writeFileSync(join(repoDir, 'README.md'), '# e2e fixture\n');
    sh('git', ['add', '-A'], { cwd: repoDir });
    sh('git', ['commit', '-m', 'fixture: readme'], { cwd: repoDir });
    sh('git', ['push', 'origin', 'main'], { cwd: repoDir });
    gitRepoWithLocalOrigin(beadsDir, join(work, 'beads-origin.git'));

    // 2. Init the Kshetra. --no-pack + --language unknown → the toolchain has no
    //    build/test/lint command, so the gates skip-and-pass and the run turns
    //    purely on the provider landing the diff. The local beads origin means
    //    init reuses it instead of creating a GitHub repo.
    console.log('▶ shreni init-kshetra --provider claude');
    sh('node', [SHRENI, 'init-kshetra',
      '--slug', slug, '--path', repoDir, '--no-pack', '--language', 'unknown',
      '--beads-path', beadsDir, '--provider', 'claude',
    ]);
    registered = true;

    // 3. File the single trivial bead (P1 so it's picked up promptly).
    const bdEnv = { ...process.env, BEADS_DIR: beadsDir };
    sh('bd', ['create', TASK_TITLE, '-d', TASK_DESC, '-t', 'task', '-p', '1'], { cwd: repoDir, env: bdEnv });
    const beadIds = parseBeadIds(sh('bd', ['list', '--status=open'], { cwd: repoDir, env: bdEnv }));
    if (beadIds.length !== 1) {
      throw new Error(`expected exactly 1 open bead after filing the task, got ${beadIds.length}: ${beadIds.join(', ')}`);
    }
    const beadId = beadIds[0];
    console.log(`▶ filed ${beadId} — running the worker`);

    // 4. Run the worker (the real deployment path) until the bead closes or the
    //    budget runs out.
    worker = spawn('node', [SHRENI, '__worker', slug], { stdio: 'inherit' });
    const deadline = Date.now() + TIMEOUT_MS;
    let status: string | null = null;
    while (status !== 'CLOSED') {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${TIMEOUT_MS}ms — ${beadId} is still ${status ?? 'open'}`);
      }
      await sleep(POLL_MS);
      status = parseBeadStatus(sh('bd', ['show', beadId], { cwd: repoDir, env: bdEnv }));
    }
    worker.kill('SIGTERM');
    worker = undefined;
    console.log(`▶ ${beadId} closed — verifying the merge`);

    // 5. Assertions: the change really landed on main as a squash commit, and
    //    the file the task asked for is present with the right content.
    const failures: string[] = [];
    const log = sh('git', ['log', '--oneline', 'main'], { cwd: repoDir });
    if (!log.includes(`bead-${beadId}`)) {
      failures.push(`no "bead-${beadId}" squash commit on main`);
    }
    const landed = join(repoDir, TASK_FILE);
    if (!existsSync(landed)) {
      failures.push(`${TASK_FILE} is not present on main after merge`);
    } else {
      const got = sh('git', ['show', `main:${TASK_FILE}`], { cwd: repoDir });
      if (!got.includes(TASK_CONTENT)) {
        failures.push(`${TASK_FILE} on main does not contain "${TASK_CONTENT}" (got: ${JSON.stringify(got)})`);
      }
    }
    // The squashed change is on the remote origin too, proving the real push.
    const originSha = sh('git', ['rev-parse', 'origin/main'], { cwd: repoDir });
    const mainSha = sh('git', ['rev-parse', 'main'], { cwd: repoDir });
    if (originSha !== mainSha) {
      failures.push(`origin/main (${originSha}) is behind main (${mainSha}) — the merge did not push`);
    }

    if (failures.length > 0) {
      console.error('\n✗ Tier 2 e2e FAILED:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n✓ Tier 2 e2e PASSED — ${beadId} merged to main and closed via a real provider pass.`);
  } finally {
    worker?.kill('SIGTERM');
    if (registered) {
      try {
        unregisterKshetra(slug);
      } catch {
        // never registered (init failed early) — nothing to unwind
      }
    }
    rmSync(work, { recursive: true, force: true });
    rmSync(join(homedir(), '.shreni', 'kshetra', slug), { recursive: true, force: true });
    rmSync(join(homedir(), '.shreni', 'rag', slug), { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(`✗ Tier 2 e2e aborted: ${(err as Error).message}`);
  process.exit(1);
});
