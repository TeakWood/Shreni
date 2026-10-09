/**
 * Pack certification harness (ARD §3.4).
 *
 * Usage:  pnpm certify <pack-name>   (requires `pnpm build` first, and SHRENI_DATABASE_URL)
 *
 * For one pack: scaffold a throwaway Kshetra from packs/<name>/reference/
 * (the fixture repo; its backlog.json and optional setup.sh are harness inputs,
 * not fixture files), run `shreni init --mode kshetra --pack <name>` against it
 * on the database, run setup.sh, file backlog.json through the task graph engine
 * as the system role (so the tasks land open), run the worker until every task
 * is done, then assert from the activity log + the engine + git that:
 *   - every backlog task merged (task_done approved + bead-<id> commit on main)
 *   - the test/lint gates ran green on the final round (silpi_done fields)
 *   - the build gate command was actually executed (agent_tool_call detail)
 *   - the scripted reviewer rejection happened (viharapala_done REJECT)
 *   - Parikshaka's discovery walk found the fixture's test files
 *
 * The fixture repo pushes to a bare repo inside the workspace, so certification
 * needs no GitHub access — only the provider CLI (claude) with credentials, git,
 * and a Postgres the engine can use (SHRENI_DATABASE_URL; CI runs a service).
 */
import { execFileSync, spawn } from 'child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import {
  parseActivityLog,
  checkBeadOutcomes,
  checkBuildGateObserved,
  checkReviewerRejectionObserved,
  checkParikshakaDiscovery,
  type CertFailure,
} from '../src/cert/assertions.js';
import { loadKshetraConfig } from '../src/kshetra/config.js';
import { loadPackByName } from '../src/kshetra/packs.js';
import { unregisterKshetra } from '../src/kshetra/registry.js';
import { resolveBuildCommand, resolveTestGlobs, resolveVendorDirs } from '../src/kshetra/toolchain.js';
import { collectTestFiles } from '../src/sthapathi/parikshaka-dispatch.js';
import { logPath } from '../src/sthapathi/activity-log.js';
import { openKshetraTasks, readBacklog, type KshetraTasks } from './lib/engine-backlog.js';

const REPO_ROOT = resolve(__dirname, '..');
const SHRENI = join(REPO_ROOT, 'dist', 'cli', 'index.js');
// Backlog runs are agent work: budget generously but hard-cap to keep a CI
// job under ~10 minutes of run time (fixture sizing enforces the rest).
const BACKLOG_TIMEOUT_MS = Number(process.env['SHRENI_CERT_TIMEOUT_MS'] ?? 9 * 60_000);
const PARIKSHAKA_GRACE_MS = Number(process.env['SHRENI_CERT_PARIKSHAKA_GRACE_MS'] ?? 90_000);
const POLL_MS = 10_000;

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

// A local bare repo standing in for GitHub: init requires an origin remote and
// the merge path pushes main — certification must not touch a real forge.
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
  const packName = process.argv[2];
  if (!packName) {
    console.error('Usage: pnpm certify <pack-name>');
    process.exit(2);
  }
  if (!existsSync(SHRENI)) {
    console.error(`Missing ${SHRENI} — run \`pnpm build\` first.`);
    process.exit(2);
  }
  if (!process.env['SHRENI_DATABASE_URL']) {
    console.error('SHRENI_DATABASE_URL is not set — certification runs the Kshetra on a Postgres database.');
    process.exit(2);
  }
  const pack = loadPackByName(packName);
  const fixtureDir = join(pack.dir, 'reference');
  const backlogFile = join(fixtureDir, 'backlog.json');
  const setupScript = join(fixtureDir, 'setup.sh');
  if (!existsSync(backlogFile)) {
    console.error(`Pack "${packName}" has no reference/backlog.json — nothing to certify.`);
    process.exit(2);
  }
  const backlog = readBacklog(backlogFile);
  if (backlog.length < 3 || backlog.length > 5) {
    console.error(`${backlogFile} lists ${backlog.length} tasks — the certification backlog must be 3–5.`);
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), `shreni-cert-${packName}-`));
  const slug = `cert-${packName}`;
  const repoDir = join(work, 'repo');
  const configPath = join(repoDir, '.shreni', 'kshetra.yaml');
  console.log(`▶ certifying ${pack.name}@${pack.version} in ${work}`);

  let worker: ReturnType<typeof spawn> | undefined;
  let tasks: KshetraTasks | undefined;
  try {
    // 1. Fixture repo + a local origin. The harness inputs stay out of the repo.
    cpSync(fixtureDir, repoDir, { recursive: true });
    rmSync(join(repoDir, 'backlog.json'), { force: true });
    rmSync(join(repoDir, 'setup.sh'), { force: true });
    gitRepoWithLocalOrigin(repoDir, join(work, 'repo-origin.git'));

    // 2. Init the Kshetra from the pack (materialization under test too),
    //    with its database and project on SHRENI_DATABASE_URL.
    console.log('▶ shreni init --mode kshetra --pack', packName);
    sh('node', [SHRENI, 'init', '--mode', 'kshetra',
      '--slug', slug, '--path', repoDir, '--pack', packName, '--provider', 'claude',
    ]);

    // 3. Fixture setup (the dependency install the harness doesn't do), then
    //    file the backlog through the engine and snapshot the ids to certify.
    if (existsSync(setupScript)) sh('bash', [setupScript], { cwd: repoDir });
    tasks = await openKshetraTasks(configPath);
    const taskIds = await tasks.file(backlog);
    console.log(`▶ backlog: ${taskIds.join(', ')}`);

    // 4. Run the worker (the real deployment path — Parikshaka's fire-and-
    //    forget dispatch needs the long-lived process) until every backlog
    //    task is done or the budget runs out.
    worker = spawn('node', [SHRENI, '__worker', slug], { stdio: 'inherit' });
    const deadline = Date.now() + BACKLOG_TIMEOUT_MS;
    let remaining = taskIds;
    while (remaining.length > 0) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${BACKLOG_TIMEOUT_MS}ms with unfinished tasks: ${remaining.join(', ')}`);
      }
      await sleep(POLL_MS);
      const states = await tasks.states(taskIds);
      const cancelled = taskIds.filter(id => states.get(id) === 'cancelled');
      if (cancelled.length > 0) throw new Error(`backlog tasks were cancelled: ${cancelled.join(', ')}`);
      remaining = taskIds.filter(id => states.get(id) !== 'done');
    }
    console.log('▶ backlog complete — waiting for Parikshaka');

    // 5. Grace period for the post-merge Parikshaka dispatch to land its
    //    discovery event, then stop the worker.
    const activityFile = logPath(slug);
    const parikshakaDeadline = Date.now() + PARIKSHAKA_GRACE_MS;
    while (Date.now() < parikshakaDeadline) {
      const events = parseActivityLog(readFileSync(activityFile, 'utf8'));
      if (events.some(e => e.type === 'agent_text' && e.agent === 'parikshaka')) break;
      await sleep(POLL_MS);
    }
    worker.kill('SIGTERM');
    worker = undefined;

    // 6. Assertions.
    const config = loadKshetraConfig(configPath);
    const events = parseActivityLog(readFileSync(activityFile, 'utf8'));
    const expectedTests = await collectTestFiles(repoDir, resolveTestGlobs(config), resolveVendorDirs(config));

    const failures: CertFailure[] = [
      ...checkBeadOutcomes(events, taskIds),
      ...checkBuildGateObserved(events, resolveBuildCommand(config)),
      ...checkReviewerRejectionObserved(events),
      ...checkParikshakaDiscovery(events, expectedTests),
    ];
    // Merged means merged: a bead-<id> squash commit is on the fixture main.
    const log = sh('git', ['log', '--oneline', 'main'], { cwd: repoDir });
    for (const id of taskIds) {
      if (!log.includes(`bead-${id}`)) {
        failures.push({ check: 'merged', beadId: id, detail: `no "bead-${id}" squash commit on main` });
      }
    }

    if (failures.length > 0) {
      console.error(`\n✗ ${pack.name}@${pack.version} FAILED certification:`);
      for (const f of failures) {
        console.error(`  [${f.check}]${f.beadId ? ` ${f.beadId}` : ''} ${f.detail}`);
      }
      process.exit(1);
    }
    console.log(`\n✓ CERTIFIED ${pack.name}@${pack.version} — ${taskIds.length} tasks merged, gates observed, discovery correct.`);
  } finally {
    worker?.kill('SIGTERM');
    await tasks?.close().catch(() => {});
    try {
      unregisterKshetra(slug);
    } catch {
      // never registered (init failed early)
    }
    rmSync(work, { recursive: true, force: true });
    rmSync(join(homedir(), '.shreni', 'kshetra', slug), { recursive: true, force: true });
    rmSync(join(homedir(), '.shreni', 'rag', slug), { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(`✗ certification aborted: ${(err as Error).message}`);
  process.exit(1);
});
