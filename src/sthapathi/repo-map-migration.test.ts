import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { git } from './git.js';
import { untrackCommittedRepoMap } from './repo-map-migration.js';
import type { KshetraConfig } from '../kshetra/config.js';

const execFileAsync = promisify(execFile);

// Integration tests over a real git repo — the migration's whole job is a
// sequence of real git state transitions (tracked → untracked, clean tree,
// gitignored), so a real repo is the honest test.
let repoDir: string;

function kshetra(): KshetraConfig {
  return {
    id: 'myapp',
    name: 'Myapp',
    repo: { path: repoDir, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: '/tmp/myapp-beads', remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  } as KshetraConfig;
}

async function initRepo() {
  await execFileAsync('git', ['init', '-b', 'main', repoDir]);
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# test');
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

// Commit a tracked .shreni/repo-map.md, reproducing the legacy state the
// migration exists to heal.
async function commitTrackedRepoMap() {
  mkdirSync(join(repoDir, '.shreni'), { recursive: true });
  writeFileSync(join(repoDir, '.shreni', 'repo-map.md'), '# Repo Map\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'chore: Add repo-map.md'], { cwd: repoDir });
}

beforeEach(async () => {
  repoDir = join(tmpdir(), `shreni-repomap-mig-${process.pid}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  await initRepo();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('untrackCommittedRepoMap', () => {
  it('untracks a committed repo-map, keeps it on disk, gitignores it, and leaves a clean tree', async () => {
    await commitTrackedRepoMap();
    const g = git(repoDir);
    expect(await g.isTracked('.shreni/repo-map.md')).toBe(true);

    const changed = await untrackCommittedRepoMap(kshetra());

    expect(changed).toBe(true);
    // File stays on disk (it is a live cache), just no longer tracked.
    expect(existsSync(join(repoDir, '.shreni', 'repo-map.md'))).toBe(true);
    expect(await g.isTracked('.shreni/repo-map.md')).toBe(false);
    // Now gitignored.
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toContain('.shreni/repo-map.md');
    // Crucially: the tree is clean, so the very wedge this heals cannot recur.
    const status = await g.status();
    expect(status.modified).toEqual([]);
    expect(status.staged).toEqual([]);
  });

  it('is idempotent — a second run is a no-op once the map is untracked', async () => {
    await commitTrackedRepoMap();
    expect(await untrackCommittedRepoMap(kshetra())).toBe(true);
    expect(await untrackCommittedRepoMap(kshetra())).toBe(false);
    // No duplicate gitignore line from the second pass.
    const lines = readFileSync(join(repoDir, '.gitignore'), 'utf8')
      .split('\n')
      .filter(l => l.trim() === '.shreni/repo-map.md');
    expect(lines).toHaveLength(1);
  });

  it('is a no-op when the map was never tracked (fresh, already-gitignored repo)', async () => {
    // Map exists on disk but is untracked (the healthy modern state).
    mkdirSync(join(repoDir, '.shreni'), { recursive: true });
    writeFileSync(join(repoDir, '.shreni', 'repo-map.md'), '# Repo Map\n');

    const before = await git(repoDir).headSha();
    expect(await untrackCommittedRepoMap(kshetra())).toBe(false);
    // No commit was created.
    expect(await git(repoDir).headSha()).toBe(before);
  });

  it('does not throw and leaves a clean tree even when the push target is missing', async () => {
    // No 'origin' remote → the best-effort push fails; the migration must still
    // succeed locally with a clean tree (push is swallowed).
    await commitTrackedRepoMap();
    await expect(untrackCommittedRepoMap(kshetra())).resolves.toBe(true);
    const status = await git(repoDir).status();
    expect(status.staged).toEqual([]);
    expect(status.modified).toEqual([]);
  });
});
