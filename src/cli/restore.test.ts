import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `shreni-restore-home-${process.pid}`);
const WORK = join(tmpdir(), `shreni-restore-work-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => HOME };
});

// The task graph engine is faked: its "project" is a list of tasks and a
// memory count. freezeEngine writes it as engine.json; restoreEngine puts it
// back from there (the real purge-then-import is covered by freeze-engine.test.ts).
const engine = vi.hoisted(() => ({
  tasks: [] as { id: string; status: string }[],
  memories: 0,
}));
vi.mock('../policy/sthapathi/snapshot', async () => {
  const { writeFileSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { createHash } = await import('crypto');
  const stats = () => {
    const ids = engine.tasks.map(t => t.id).sort();
    return {
      beadCount: ids.length, memoryCount: engine.memories,
      openCount: engine.tasks.filter(t => t.status !== 'closed').length,
      closedCount: engine.tasks.filter(t => t.status === 'closed').length,
      beadIdHash: 'sha256:' + createHash('sha256').update(ids.join('\n')).digest('hex'),
    };
  };
  return {
    freezeEngine: async (k: { project: string }, outDir: string) => {
      writeFileSync(join(outDir, 'engine.json'), JSON.stringify(engine));
      return { info: { projectId: k.project, lastEventId: '42', eventCount: 3, snapshotPath: 'engine.json' }, stats: stats() };
    },
    restoreEngine: async (_k: unknown, fromDir: string, info: { snapshotPath: string }) => {
      const frozen = JSON.parse(readFileSync(join(fromDir, info.snapshotPath), 'utf8'));
      engine.tasks = frozen.tasks;
      engine.memories = frozen.memories;
      return { stats: stats(), matches: true, lastEventId: '43' };
    },
  };
});

const { runFreeze } = await import('./freeze.js');
const { runRestore } = await import('./restore.js');
const { makeContext } = await import('./registry.js');

const KID = 'testk';
const PROJECT = '0b9d6f4e-6a43-4c1e-9d77-2f6f3c1a9e10';

function ctx(args: string[]) {
  return makeContext(args);
}

function statePath() {
  return join(HOME, '.shreni', 'state.json');
}
function runtimeFile(name: string) {
  return join(HOME, '.shreni', 'kshetra', KID, name);
}
const ledgerFile = () => runtimeFile('ledger.jsonl');

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(HOME, '.shreni'), { recursive: true });

  engine.tasks = [{ id: 'testk-1', status: 'open' }, { id: 'testk-2', status: 'closed' }];
  engine.memories = 1;

  const cfgPath = join(WORK, 'kshetra.yaml');
  mkdirSync(WORK, { recursive: true });
  writeFileSync(
    cfgPath,
    [
      `id: ${KID}`, 'name: TestK', `project: ${PROJECT}`,
      'repo:', `  path: ${join(WORK, 'repo')}`, "  remote: ''",
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
  writeFileSync(ledgerFile(), '{"kind":"prev-trial"}\n');
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

// Add tasks/memories the snapshot did NOT have, to prove the restore replaces them.
function mutateTasks() {
  engine.tasks.push({ id: 'testk-3', status: 'open' }, { id: 'testk-4', status: 'open' }, { id: 'testk-5', status: 'open' });
  engine.memories += 2;
}

describe('runRestore', () => {
  it('a kshetra that gained 3 tasks + 2 memories reverts to the snapshot exactly', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    mutateTasks();

    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']));

    expect(engine.tasks).toHaveLength(2);
    expect(engine.memories).toBe(1);
    expect(engine.tasks.some(t => t.id === 'testk-3')).toBe(false); // the gained tasks are gone
  });

  it('refuses an old beads-format snapshot before touching any state', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    // What a pre-engine freeze wrote: schema v1, a beads location, no engine section.
    const m = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));
    m.schemaVersion = 1;
    delete m.engine;
    m.beads.headSha = 'abc123';
    m.locations.unshift({ key: 'beads', role: 'beads', kind: 'dir', sourcePath: '/old/beads', present: true, snapshotPath: 'beads', sizeBytes: 1 });
    writeFileSync(join(snap, 'manifest.json'), JSON.stringify(m));
    writeFileSync(runtimeFile('activity.jsonl'), '{"t":"LIVE"}\n');
    mutateTasks();
    const archiveBase = join(WORK, 'arch');

    await expect(
      runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes', '--archive', archiveBase])),
    ).rejects.toThrow(/beads snapshots can no longer be restored/);

    // Nothing was archived or restored: the live state is as it was.
    expect(existsSync(archiveBase)).toBe(false);
    expect(readFileSync(runtimeFile('activity.jsonl'), 'utf8')).toContain('LIVE');
    expect(engine.tasks).toHaveLength(5);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).kshetras[KID].paused).toBe(true);
  });

  it('refuses a Kshetra with no project, naming shreni migrate', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    const cfgPath = join(WORK, 'kshetra.yaml');
    writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(/^project:.*\n/m, ''));
    await expect(runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']))).rejects.toThrow(/run shreni migrate testk/);
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

  it('--latest resolves a parent to the newest snapshot by createdAt and announces it', async () => {
    const parent = join(WORK, 'snaps');
    // Two snapshots under one parent; rewrite createdAt so ordering is deterministic.
    await freezeTo(join(parent, 'older'));
    await freezeTo(join(parent, 'newer'));
    const olderM = join(parent, 'older', 'manifest.json');
    const newerM = join(parent, 'newer', 'manifest.json');
    const setCreatedAt = (p: string, at: string) => {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      m.createdAt = at;
      writeFileSync(p, JSON.stringify(m));
    };
    setCreatedAt(olderM, '2026-09-20T10:00:00.000Z');
    setCreatedAt(newerM, '2026-09-21T10:00:00.000Z');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(m => void logs.push(String(m)));
    try {
      await runRestore(ctx(['--kshetra', KID, '--from', parent, '--latest', '--yes']));
    } finally {
      spy.mockRestore();
    }
    const announce = logs.find(l => l.startsWith('--latest'));
    expect(announce).toContain('→ newer ');
    expect(announce).toContain('2026-09-21T10:00:00.000Z');
    expect(announce).not.toContain('→ older ');
  });

  it('--latest fails when the parent has no snapshot for this kshetra', async () => {
    const parent = join(WORK, 'empty-parent');
    mkdirSync(parent, { recursive: true });
    await expect(
      runRestore(ctx(['--kshetra', KID, '--from', parent, '--latest', '--yes'])),
    ).rejects.toThrow(/no restorable snapshot/i);
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

    // live per-trial feeds are empty (activity/usage fully cleared)
    expect(readFileSync(runtimeFile('activity.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(runtimeFile('usage.jsonl'), 'utf8')).toBe('');
    // the ledger's prior contents are cleared; its ONLY entry is the boundary
    // marker appended after the wipe (a rewound ledger, not a truncated one).
    const ledgerLines = readFileSync(ledgerFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(ledgerLines).toHaveLength(1);
    expect(ledgerLines[0].kind).toBe('state_restored');

    // the archive holds the pre-restore activity
    const tsDir = join(archiveBase, readdirSync(archiveBase)[0]);
    expect(readFileSync(join(tsDir, 'runtime', 'activity.jsonl'), 'utf8')).toContain('PRE-RESTORE');
    // ledger.jsonl lives in the runtime dir → archived with it
    expect(readFileSync(join(tsDir, 'runtime', 'ledger.jsonl'), 'utf8')).toContain('prev-trial');
  });

  it('default (no --clean) restores the snapshot per-trial feeds', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    writeFileSync(runtimeFile('activity.jsonl'), '{"t":"changed"}\n');
    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']));
    expect(readFileSync(runtimeFile('activity.jsonl'), 'utf8')).toContain('seed-activity');
  });

  it('appends state_restored to the restored ledger; --clean makes it the first entry', async () => {
    const snap = join(WORK, 'snap');
    await freezeTo(snap);
    const m = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));

    // Default: the snapshot's ledger (with the seed entry) is restored, then
    // state_restored is appended at the boundary — so the seed is still above it.
    await runRestore(ctx(['--kshetra', KID, '--from', snap, '--yes']));
    let lines = readFileSync(ledgerFile(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const last = lines[lines.length - 1];
    expect(last.kind).toBe('state_restored');
    expect(last.payload.snapshotId).toBe(m.snapshotId);
    expect(last.payload.archivePath).toContain('archive');
    expect(last.payload.clean).toBe(false);
    expect(last.payload.lastEventId).toBe('43');
    expect(lines.some(l => l.kind === 'prev-trial' || l.kind === 'task_done')).toBe(true); // seed still above

    // --clean: ledger emptied first, so state_restored is the FIRST (only) entry —
    // a rewound ledger, not one that silently lost history.
    await freezeTo(join(WORK, 'snap2'));
    await runRestore(ctx(['--kshetra', KID, '--from', join(WORK, 'snap2'), '--yes', '--clean']));
    lines = readFileSync(ledgerFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('state_restored');
    expect(lines[0].payload.clean).toBe(true);
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
