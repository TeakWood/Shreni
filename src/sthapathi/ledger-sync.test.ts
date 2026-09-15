// Integration test for 4a2.4: syncBeads commits and pushes ledger.jsonl. Unlike
// beads.test.ts (which mocks child_process to assert the git COMMAND sequence),
// this drives REAL git against temp repos so it can prove the end-state the
// acceptance criteria name: ledger.jsonl appears in `git ls-files`, is pushed to
// the remote, rides in ONE commit per sync, produces no spurious commit when
// unchanged, and is NOT caught by the beads repo's .gitignore.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { syncBeads } from './beads.js';
import type { KshetraConfig } from '../kshetra/config.js';

// The interactions.jsonl-ignoring subset of the real bd-managed beads .gitignore.
// The point: interactions.jsonl IS ignored, ledger.jsonl is NOT.
const BEADS_GITIGNORE = [
  'dolt/',
  'embeddeddolt/',
  'interactions.jsonl',
  'export-state.json',
  '*.lock',
  '',
].join('\n');

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let root: string;
let remote: string;
let work: string;
let kshetra: KshetraConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-sync-'));
  remote = join(root, 'remote.git');
  work = join(root, 'beads');

  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-b', 'main', work]);
  g(work, 'config', 'user.email', 'test@shreni.dev');
  g(work, 'config', 'user.name', 'Shreni Test');
  g(work, 'remote', 'add', 'origin', remote);
  // Seed the repo as bd would: a tracked issues.jsonl + the bd .gitignore, then
  // publish main so origin/main exists for syncBeads' pull --rebase.
  writeFileSync(join(work, 'issues.jsonl'), '{"id":"x-1"}\n');
  writeFileSync(join(work, '.gitignore'), BEADS_GITIGNORE);
  g(work, 'add', '-A');
  g(work, 'commit', '-m', 'seed');
  g(work, 'push', '-u', 'origin', 'main');

  kshetra = {
    id: 'myapp',
    name: 'Myapp',
    repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: work, remote, mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { model: 'm', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  } as KshetraConfig;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('syncBeads commits the ledger (4a2.4)', () => {
  it('stages, commits and pushes ledger.jsonl in one commit', async () => {
    writeFileSync(join(work, 'ledger.jsonl'), '{"kind":"task_claimed","beadId":"b1"}\n');
    const before = Number(g(work, 'rev-list', '--count', 'HEAD'));

    await syncBeads(kshetra);

    // Tracked locally…
    expect(g(work, 'ls-files').split('\n')).toContain('ledger.jsonl');
    // …in exactly one new commit…
    expect(Number(g(work, 'rev-list', '--count', 'HEAD'))).toBe(before + 1);
    // …and pushed to the remote.
    expect(g(work, 'ls-tree', '-r', '--name-only', 'origin/main').split('\n')).toContain('ledger.jsonl');
  });

  it('the beads .gitignore catches interactions.jsonl but NOT ledger.jsonl', async () => {
    writeFileSync(join(work, 'ledger.jsonl'), '{"kind":"merge_done","beadId":"b1"}\n');
    writeFileSync(join(work, 'interactions.jsonl'), '{"kind":"field_change"}\n');

    await syncBeads(kshetra);

    const tracked = g(work, 'ls-files').split('\n');
    expect(tracked).toContain('ledger.jsonl');
    expect(tracked).not.toContain('interactions.jsonl');
  });

  it('a sync with no new ledger entries produces no spurious commit', async () => {
    writeFileSync(join(work, 'ledger.jsonl'), '{"kind":"task_done","beadId":"b1"}\n');
    await syncBeads(kshetra);
    const after = Number(g(work, 'rev-list', '--count', 'HEAD'));

    // Nothing changed in the working tree — the second sync must not commit.
    await syncBeads(kshetra);
    expect(Number(g(work, 'rev-list', '--count', 'HEAD'))).toBe(after);
  });
});
