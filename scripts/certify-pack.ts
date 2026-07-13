/**
 * Pack certification harness (ARD §3.4, Shreni-beads-84m.4).
 *
 * Usage:  pnpm certify <pack-name>            (requires `pnpm build` first)
 *
 * For one pack: scaffold a throwaway Kshetra from packs/<name>/reference/
 * (the fixture repo, with backlog.sh at its root), run `shreni init-kshetra
 * --pack <name>` against it, file the fixture backlog, run the worker until
 * the backlog completes, then assert from the activity log + bd + git that:
 *   - every backlog bead merged (task_done approved + bead-<id> commit on main)
 *   - the test/lint gates ran green on the final round (silpi_done fields)
 *   - the build gate command was actually executed (agent_tool_call detail)
 *   - the scripted reviewer rejection happened (viharapala_done REJECT)
 *   - Parikshaka's discovery walk found the fixture's test files
 *
 * Everything is local: both the fixture repo and the beads repo push to bare
 * repos inside the workspace, so certification needs no GitHub access — only
 * the provider CLI (claude) with credentials, bd, and git.
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
  parseBeadIds,
  parseBeadStatus,
  type CertFailure,
} from '../src/cert/assertions.js';
import { loadKshetraConfig } from '../src/kshetra/config.js';
import { loadPackByName } from '../src/kshetra/packs.js';
import { unregisterKshetra } from '../src/kshetra/registry.js';
import { resolveBuildCommand, resolveTestGlobs, resolveVendorDirs } from '../src/kshetra/toolchain.js';
import { collectTestFiles } from '../src/sthapathi/parikshaka-dispatch.js';
import { logPath } from '../src/sthapathi/activity-log.js';

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
  const pack = loadPackByName(packName);
  const fixtureDir = join(pack.dir, 'reference');
  const backlogScript = join(fixtureDir, 'backlog.sh');
  if (!existsSync(backlogScript)) {
    console.error(`Pack "${packName}" has no reference/backlog.sh — nothing to certify.`);
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), `shreni-cert-${packName}-`));
  const slug = `cert-${packName}`;
  const repoDir = join(work, 'repo');
  const beadsDir = join(work, 'beads');
  console.log(`▶ certifying ${pack.name}@${pack.version} in ${work}`);

  let worker: ReturnType<typeof spawn> | undefined;
  try {
    // 1. Fixture repo + local origins (repo and beads both push locally).
    cpSync(fixtureDir, repoDir, { recursive: true });
    rmSync(join(repoDir, 'backlog.sh'), { force: true });
    gitRepoWithLocalOrigin(repoDir, join(work, 'repo-origin.git'));
    gitRepoWithLocalOrigin(beadsDir, join(work, 'beads-origin.git'));

    // 2. Init the Kshetra from the pack (materialization under test too).
    console.log('▶ shreni init-kshetra --pack', packName);
    sh('node', [SHRENI, 'init-kshetra',
      '--slug', slug, '--path', repoDir, '--pack', packName,
      '--beads-path', beadsDir, '--provider', 'claude',
    ]);

    // 3. File the fixture backlog and snapshot the bead ids to certify.
    const bdEnv = { ...process.env, BEADS_DIR: beadsDir };
    sh('bash', [backlogScript], { cwd: repoDir, env: bdEnv });
    const beadIds = parseBeadIds(sh('bd', ['list', '--status=open'], { cwd: repoDir, env: bdEnv }));
    if (beadIds.length < 3 || beadIds.length > 5) {
      throw new Error(`backlog.sh filed ${beadIds.length} beads — the certification backlog must be 3–5.`);
    }
    console.log(`▶ backlog: ${beadIds.join(', ')}`);

    // 4. Run the worker (the real deployment path — Parikshaka's fire-and-
    //    forget dispatch needs the long-lived process) until every backlog
    //    bead closes or the budget runs out.
    worker = spawn('node', [SHRENI, '__worker', slug], { stdio: 'inherit' });
    const deadline = Date.now() + BACKLOG_TIMEOUT_MS;
    let remaining = beadIds;
    while (remaining.length > 0) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${BACKLOG_TIMEOUT_MS}ms with open beads: ${remaining.join(', ')}`);
      }
      await sleep(POLL_MS);
      remaining = beadIds.filter(
        id => parseBeadStatus(sh('bd', ['show', id], { cwd: repoDir, env: bdEnv })) !== 'CLOSED',
      );
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
    const config = loadKshetraConfig(join(repoDir, '.shreni', 'kshetra.yaml'));
    const events = parseActivityLog(readFileSync(activityFile, 'utf8'));
    const expectedTests = await collectTestFiles(repoDir, resolveTestGlobs(config), resolveVendorDirs(config));

    const failures: CertFailure[] = [
      ...checkBeadOutcomes(events, beadIds),
      ...checkBuildGateObserved(events, resolveBuildCommand(config)),
      ...checkReviewerRejectionObserved(events),
      ...checkParikshakaDiscovery(events, expectedTests),
    ];
    // Merged means merged: a bead-<id> squash commit is on the fixture main.
    const log = sh('git', ['log', '--oneline', 'main'], { cwd: repoDir });
    for (const id of beadIds) {
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
    console.log(`\n✓ CERTIFIED ${pack.name}@${pack.version} — ${beadIds.length} beads merged, gates observed, discovery correct.`);
  } finally {
    worker?.kill('SIGTERM');
    try {
      unregisterKshetra(slug);
    } catch {
      // never registered (init failed early)
    }
    rmSync(work, { recursive: true, force: true });
    rmSync(join(homedir(), '.shreni', 'kshetra', slug), { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(`✗ certification aborted: ${(err as Error).message}`);
  process.exit(1);
});
