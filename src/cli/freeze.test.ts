import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const HOME = join(tmpdir(), `shreni-freeze-home-${process.pid}`);
const WORK = join(tmpdir(), `shreni-freeze-work-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => HOME };
});

const { runFreeze, resolveFreezeOutDir } = await import('./freeze.js');
const { makeContext } = await import('./registry.js');

const KID = 'testk';
const beadsPath = join(WORK, 'beads');
const repoPath = join(WORK, 'repo');

function ctx(args: string[]) {
  return makeContext(args);
}

function seedBeads(issues: object[]): void {
  mkdirSync(beadsPath, { recursive: true });
  writeFileSync(
    join(beadsPath, 'issues.jsonl'),
    issues.map(i => JSON.stringify(i)).join('\n') + '\n',
  );
  writeFileSync(
    join(beadsPath, 'export-state.json'),
    JSON.stringify({ last_dolt_commit: 'dolt-xyz', issues: issues.length }),
  );
  writeFileSync(join(beadsPath, 'ledger.jsonl'), JSON.stringify({ kind: 'task_done', beadId: 'testk-2' }) + '\n');
  // Make it a real git repo so headSha is captured.
  execFileSync('git', ['-C', beadsPath, 'init', '-q']);
  execFileSync('git', ['-C', beadsPath, 'add', '-A']);
  execFileSync('git', [
    '-C', beadsPath,
    '-c', 'user.email=t@e.st', '-c', 'user.name=Test',
    'commit', '-q', '-m', 'seed',
  ]);
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  seedBeads([
    { _type: 'issue', id: 'testk-1', status: 'open' },
    { _type: 'issue', id: 'testk-2', status: 'closed' },
    { _type: 'memory', key: 'm1', value: 'insight' },
  ]);

  // kshetra.yaml + registry
  const cfgPath = join(WORK, 'kshetra.yaml');
  writeFileSync(
    cfgPath,
    [
      `id: ${KID}`,
      'name: TestK',
      'repo:',
      `  path: ${repoPath}`,
      "  remote: ''",
      'beads:',
      `  path: ${beadsPath}`,
      "  remote: ''",
      'stack:',
      '  language: typescript',
    ].join('\n'),
  );
  mkdirSync(join(HOME, '.shreni'), { recursive: true });
  writeFileSync(
    join(HOME, '.shreni', 'registry.json'),
    JSON.stringify({ kshetras: [{ id: KID, configPath: cfgPath, registeredAt: 'now' }] }),
  );

  // machine-side runtime dir + rag index
  mkdirSync(join(HOME, '.shreni', 'kshetra', KID), { recursive: true });
  writeFileSync(join(HOME, '.shreni', 'kshetra', KID, 'activity.jsonl'), '{"t":"x"}\n');
  mkdirSync(join(HOME, '.shreni', 'rag', KID), { recursive: true });
  writeFileSync(join(HOME, '.shreni', 'rag', KID, 'index.json'), '{"chunks":[]}');

  // global state.json with THIS kshetra's slice AND another kshetra's slice.
  writeFileSync(
    join(HOME, '.shreni', 'state.json'),
    JSON.stringify({
      kshetras: {
        [KID]: { paused: true, reason: 'manual' },
        other: { paused: false },
      },
    }),
  );
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
});

describe('runFreeze', () => {
  it('captures counts, ids hash, slices, and copies (not the work repo)', async () => {
    const out = join(WORK, 'snap');
    await runFreeze(ctx(['--kshetra', KID, '--out', out, '--label', 'arm=A']));

    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m.beads.beadCount).toBe(2);
    expect(m.beads.memoryCount).toBe(1);
    expect(m.beads.closedCount).toBe(1);
    expect(m.beads.lastDoltCommit).toBe('dolt-xyz');
    expect(m.beads.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.labels).toEqual({ arm: 'A' });
    expect(m.repoPath).toBe(repoPath);

    // beads + runtime + rag copied
    expect(existsSync(join(out, 'beads', 'issues.jsonl'))).toBe(true);
    expect(existsSync(join(out, 'runtime', 'activity.jsonl'))).toBe(true);
    expect(existsSync(join(out, 'rag', 'index.json'))).toBe(true);
    expect(m.rag.present).toBe(true);

    // the work repo is NOT copied
    expect(existsSync(join(out, 'repo'))).toBe(false);
    expect(m.locations.some((l: { sourcePath: string }) => l.sourcePath === repoPath)).toBe(false);

    // only THIS kshetra's state slice is captured (no 'other')
    const slice = JSON.parse(readFileSync(join(out, 'flags.json'), 'utf8'));
    expect(slice).toEqual({ paused: true, reason: 'manual' });
    const flagsEntry = m.locations.find((l: { key: string }) => l.key === 'flags');
    expect(flagsEntry.sliceKey).toBe(KID);
  });

  it('stamps a stable snapshotId and appends a state_frozen entry to the live ledger', async () => {
    const out = join(WORK, 'snap');
    await runFreeze(ctx(['--kshetra', KID, '--out', out, '--label', 'arm=A']));
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m.snapshotId).toMatch(/^snap:[0-9a-f]{32}$/);

    // The snapshot's OWN ledger predates the freeze (copied before the append)...
    expect(existsSync(join(out, 'beads', 'ledger.jsonl'))).toBe(true);
    expect(readFileSync(join(out, 'beads', 'ledger.jsonl'), 'utf8')).not.toContain('state_frozen');
    // ...but the LIVE ledger records it.
    const live = readFileSync(join(beadsPath, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const frozen = live.find(e => e.kind === 'state_frozen');
    expect(frozen).toBeTruthy();
    expect(frozen.payload.snapshotId).toBe(m.snapshotId);
    expect(frozen.payload.beadCount).toBe(2);
    expect(frozen.payload.memoryCount).toBe(1);
    expect(frozen.payload.labels).toEqual({ arm: 'A' });
    expect(frozen.beadId).toBe(''); // kshetra-level, not bead-level
  });

  it('bead-id hash is stable across two consecutive freezes of an unchanged kshetra', async () => {
    const out1 = join(WORK, 'snap1');
    const out2 = join(WORK, 'snap2');
    await runFreeze(ctx(['--kshetra', KID, '--out', out1]));
    await runFreeze(ctx(['--kshetra', KID, '--out', out2]));
    const h1 = JSON.parse(readFileSync(join(out1, 'manifest.json'), 'utf8')).beads.beadIdHash;
    const h2 = JSON.parse(readFileSync(join(out2, 'manifest.json'), 'utf8')).beads.beadIdHash;
    expect(h1).toBe(h2);
  });

  it('freezing a kshetra with no RAG index succeeds and records its absence', async () => {
    rmSync(join(HOME, '.shreni', 'rag', KID), { recursive: true, force: true });
    const out = join(WORK, 'snap');
    await runFreeze(ctx(['--kshetra', KID, '--out', out]));
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m.rag.present).toBe(false);
    expect(m.rag.sizeBytes).toBe(0);
    expect(existsSync(join(out, 'rag'))).toBe(false);
  });

  it('refuses to freeze while a worker is alive, unless --force', async () => {
    writeFileSync(join(HOME, '.shreni', 'kshetra', KID, 'worker.pid'), String(process.pid));
    await expect(runFreeze(ctx(['--kshetra', KID, '--out', join(WORK, 'a')]))).rejects.toThrow(
      /alive/i,
    );
    // --force overrides
    await runFreeze(ctx(['--kshetra', KID, '--out', join(WORK, 'b'), '--force']));
    expect(existsSync(join(WORK, 'b', 'manifest.json'))).toBe(true);
  });

  it('refuses a missing kshetra, missing flags, and a non-empty out dir', async () => {
    await expect(runFreeze(ctx(['--kshetra', 'ghost', '--out', join(WORK, 'x')]))).rejects.toThrow(
      /not found/i,
    );
    await expect(runFreeze(ctx(['--kshetra', KID]))).rejects.toThrow(/--out/);
    const nonEmpty = join(WORK, 'ne');
    mkdirSync(nonEmpty, { recursive: true });
    writeFileSync(join(nonEmpty, 'x'), 'y');
    await expect(runFreeze(ctx(['--kshetra', KID, '--out', nonEmpty]))).rejects.toThrow(/not empty/i);
  });

  describe('resolveFreezeOutDir (parent-dir resolution)', () => {
    const NOW = new Date('2026-09-21T14:30:05.123Z');

    it('returns the dir itself when absent or empty (backward compatible)', () => {
      const absent = join(WORK, 'nope');
      expect(resolveFreezeOutDir(absent, {}, NOW)).toBe(absent);
      const empty = join(WORK, 'empty');
      mkdirSync(empty, { recursive: true });
      expect(resolveFreezeOutDir(empty, {}, NOW)).toBe(empty);
    });

    it('treats a directory of snapshots as a parent and stamps a timestamped subdir', () => {
      const parent = join(WORK, 'parent');
      mkdirSync(join(parent, 'old-snap'), { recursive: true });
      writeFileSync(join(parent, 'old-snap', 'manifest.json'), '{}');
      writeFileSync(join(parent, '.DS_Store'), 'junk'); // ignorable

      const resolved = resolveFreezeOutDir(parent, {}, NOW);
      expect(resolved).toBe(join(parent, '2026-09-21-143005'));
    });

    it('carries the stage label into the subdir slug, sanitised', () => {
      const parent = join(WORK, 'parent');
      mkdirSync(join(parent, 'old-snap'), { recursive: true });
      writeFileSync(join(parent, 'old-snap', 'manifest.json'), '{}');

      const resolved = resolveFreezeOutDir(parent, { stage: 'Warm Up!' }, NOW);
      expect(resolved).toBe(join(parent, '2026-09-21-143005-warm-up'));
    });

    it('steps to a -N suffix on a same-second collision with a non-empty subdir', () => {
      const parent = join(WORK, 'parent');
      mkdirSync(join(parent, 'old-snap'), { recursive: true });
      writeFileSync(join(parent, 'old-snap', 'manifest.json'), '{}');
      // A prior freeze already claimed this exact stamp.
      const taken = join(parent, '2026-09-21-143005');
      mkdirSync(taken, { recursive: true });
      writeFileSync(join(taken, 'manifest.json'), '{}');

      expect(resolveFreezeOutDir(parent, {}, NOW)).toBe(join(parent, '2026-09-21-143005-2'));
    });

    it('refuses a non-empty directory that is not a snapshot parent', () => {
      const dir = join(WORK, 'mixed');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'unrelated.txt'), 'stuff');
      expect(() => resolveFreezeOutDir(dir, {}, NOW)).toThrow(/not a snapshot parent/i);
    });
  });

  it('freeze --out on a parent of snapshots writes a timestamped subdir and prints it', async () => {
    const parent = join(WORK, 'snaps');
    // First freeze lands directly in a fresh dir under the parent.
    await runFreeze(ctx(['--kshetra', KID, '--out', join(parent, 'seed')]));
    // Second freeze targets the now-populated parent → nested timestamped subdir.
    await runFreeze(ctx(['--kshetra', KID, '--out', parent, '--label', 'stage=trial1']));

    const subdirs = readdirSync(parent).filter(n => n !== 'seed');
    expect(subdirs).toHaveLength(1);
    expect(subdirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-trial1$/);
    expect(existsSync(join(parent, subdirs[0], 'manifest.json'))).toBe(true);
  });

  it('freeze --json emits the resolved dir and snapshot facts', async () => {
    const parent = join(WORK, 'snaps');
    await runFreeze(ctx(['--kshetra', KID, '--out', join(parent, 'seed')]));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(m => void logs.push(String(m)));
    try {
      await runFreeze(ctx(['--kshetra', KID, '--out', parent, '--json']));
    } finally {
      spy.mockRestore();
    }
    const payload = JSON.parse(logs[logs.length - 1]);
    expect(payload.kshetraId).toBe(KID);
    expect(payload.outDir.startsWith(parent)).toBe(true);
    expect(payload.outDir).not.toBe(parent); // resolved into a subdir
    expect(payload.snapshotId).toMatch(/^snap:[0-9a-f]{32}$/);
    expect(payload.beadCount).toBe(2);
    expect(existsSync(join(payload.outDir, 'manifest.json'))).toBe(true);
  });
});
