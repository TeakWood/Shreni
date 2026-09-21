import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const HOME = join(tmpdir(), `shreni-restore-home-${process.pid}`);
const WORK = join(tmpdir(), `shreni-restore-work-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => HOME };
});

const { runFreeze } = await import('./freeze.js');
const { runRestore } = await import('./restore.js');
const { makeContext } = await import('./registry.js');

const KID = 'testk';
const beadsPath = join(WORK, 'beads');

function ctx(args: string[]) {
  return makeContext(args);
}

function seedBeads(issues: object[]): void {
  mkdirSync(beadsPath, { recursive: true });
  writeFileSync(join(beadsPath, 'issues.jsonl'), issues.map(i => JSON.stringify(i)).join('\n') + '\n');
  writeFileSync(join(beadsPath, 'export-state.json'), JSON.stringify({ last_dolt_commit: 'dolt-xyz' }));
  writeFileSync(join(beadsPath, 'ledger.jsonl'), '{"kind":"prev-trial"}\n');
  execFileSync('git', ['-C', beadsPath, 'init', '-q']);
  execFileSync('git', ['-C', beadsPath, 'add', '-A']);
  execFileSync('git', [
    '-C', beadsPath, '-c', 'user.email=t@e.st', '-c', 'user.name=Test',
    'commit', '-q', '-m', 'seed',
  ]);
}

function statePath() {
  return join(HOME, '.shreni', 'state.json');
}
function runtimeFile(name: string) {
  return join(HOME, '.shreni', 'kshetra', KID, name);
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(HOME, '.shreni'), { recursive: true });

  seedBeads([
    { _type: 'issue', id: 'testk-1', status: 'open' },
    { _type: 'issue', id: 'testk-2', status: 'closed' },
    { _type: 'memory', key: 'm1', value: 'insight' },
  ]);

  const cfgPath = join(WORK, 'kshetra.yaml');
  writeFileSync(
    cfgPath,
    [
      `id: ${KID}`, 'name: TestK',
      'repo:', `  path: ${join(WORK, 'repo')}`, "  remote: ''",
      'beads:', `  path: ${beadsPath}`, "  remote: ''",
      'stack:', '  language: typescript',
    ].join('\n'),
  );
  writeFileSync(
    join(HOME, '.shreni', 'registry.json'),
    JSON.stringify({ kshetras: [{ id: KID, configPath: cfgPath, registeredAt: 'now' }] }),
  );

  mkdirSync(join(HOME, '.shreni', 'kshetra', KID), { recursive: true });
  writeFileSync(runtimeFile('activity.jsonl'), '{"t":"seed-activity"}\n');
  writeFileSync(runtimeFile('usage.jsonl'), '{"t":"seed-usage"}\n');
  mkdirSync(join(HOME, '.shreni', 'rag', KID), { recursive: true });
  writeFileSync(join(HOME, '.shreni', 'rag', KID, 'index.json'), '{"chunks":[]}');

  // This kshetra is paused at freeze; another kshetra also has an entry.
  writeFileSync(
    statePath(),
    JSON.stringify({
      kshetras: {
        [KID]: { paused: true, reason: 'manual', requiresManualResume: true },
        other: { paused: false, healthBaseline: 3 },
      },
    }),
  );
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
});

async function freezeTo(dir: string) {
  await runFreeze(ctx(['--kshetra', KID, '--out', dir]));
}

// Add beads/memories the snapshot did NOT have, to prove delete-then-copy.
function mutateBeads() {
  appendFileSync(
    join(beadsPath, 'issues.jsonl'),
    [
      { _type: 'issue', id: 'testk-3', status: 'open' },
      { _type: 'issue', id: 'testk-4', status: 'open' },
      { _type: 'issue', id: 'testk-5', status: 'open' },
      { _type: 'memory', key: 'm2', value: 'leaked' },
      { _type: 'memory', key: 'm3', value: 'leaked' },
    ].map(i => JSON.stringify(i)).join('\n') + '\n',
  );
}

describe('runRestore', () => {
  it('delete-then-copy: a kshetra that gained 3 beads + 2 memories reverts to the snapshot exactly', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    mutateBeads();

    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']));

    const lines = readFileSync(join(beadsPath, 'issues.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.filter(l => l._type === 'issue')).toHaveLength(2);
    expect(lines.filter(l => l._type === 'memory')).toHaveLength(1);
    expect(lines.some(l => l.id === 'testk-3')).toBe(false); // the gained beads are gone
  });

  it('merges the state slice back: other kshetras untouched, this one reset and unpaused', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']));

    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(state.kshetras.other).toEqual({ paused: false, healthBaseline: 3 }); // untouched
    expect(state.kshetras[KID].paused).toBe(false); // reset, even though frozen paused
    expect(state.kshetras[KID].requiresManualResume).toBe(false);
    expect(state.kshetras[KID].stuck).toBeUndefined();
  });

  it('fails non-zero and names the failed check on a tampered manifest', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    const m = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));
    m.beads.beadIdHash = 'sha256:deadbeef'; // tamper
    writeFileSync(join(snap, 'manifest.json'), JSON.stringify(m));

    await expect(runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']))).rejects.toThrow(
      /verification FAILED[\s\S]*beadIdHash/,
    );
  });

  it('--clean empties the per-trial feeds while the archive keeps the previous contents', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    // Distinctive pre-restore content to find in the archive.
    writeFileSync(runtimeFile('activity.jsonl'), '{"t":"PRE-RESTORE"}\n');
    const archiveBase = join(WORK, 'arch');

    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes', '--clean', '--archive', archiveBase]));

    // live per-trial feeds are empty
    expect(readFileSync(runtimeFile('activity.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(runtimeFile('usage.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(join(beadsPath, 'ledger.jsonl'), 'utf8')).toBe('');

    // the archive holds the pre-restore activity
    const tsDir = join(archiveBase, readdirSync(archiveBase)[0]);
    expect(readFileSync(join(tsDir, 'runtime', 'activity.jsonl'), 'utf8')).toContain('PRE-RESTORE');
    // ledger.jsonl lived in the beads dir → archived with it
    expect(readFileSync(join(tsDir, 'beads', 'ledger.jsonl'), 'utf8')).toContain('prev-trial');
  });

  it('default (no --clean) restores the snapshot per-trial feeds', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    writeFileSync(runtimeFile('activity.jsonl'), '{"t":"changed"}\n');
    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']));
    expect(readFileSync(runtimeFile('activity.jsonl'), 'utf8')).toContain('seed-activity');
  });

  it('refuses without --yes, on a missing kshetra, and while a worker is alive', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    await expect(runRestore(ctx(['--kshetra', KID, '--from', snap]))).rejects.toThrow(/--yes/);
    await expect(runRestore(ctx(['--kshetra', 'ghost', '--from', snap, '--yes']))).rejects.toThrow(/not found/i);

    writeFileSync(runtimeFile('worker.pid'), String(process.pid));
    await expect(runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']))).rejects.toThrow(/alive/i);
  });

  it('refuses a cross-kshetra snapshot and a corrupt/missing manifest', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    const m = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));
    m.kshetraId = 'someone-else';
    writeFileSync(join(snap, 'manifest.json'), JSON.stringify(m));
    await expect(runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']))).rejects.toThrow(
      /not "testk"|cross-restore/i,
    );

    await expect(
      runRestore(ctx(['--kshetra', KID, '--from', join(WORK, 'nope'), '--yes'])),
    ).rejects.toThrow(/no manifest\.json/i);
  });
});
