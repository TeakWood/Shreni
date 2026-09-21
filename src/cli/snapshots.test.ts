import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { runSnapshots } = await import('./snapshots.js');
const { makeContext } = await import('./registry.js');

const ROOT = join(tmpdir(), `shreni-snapshots-${process.pid}`);

function ctx(args: string[]) {
  return makeContext(args);
}

// Write a snapshot subdir with a manifest. `beadIdHash` controls state identity;
// two snapshots sharing it are "the same starting state".
function writeSnap(
  parent: string,
  dir: string,
  opts: {
    createdAt: string;
    kshetraId?: string;
    beadCount?: number;
    memoryCount?: number;
    beadIdHash?: string;
    labels?: Record<string, string>;
    version?: string;
    commit?: string | null;
    dirty?: boolean | null;
    schemaVersion?: number;
    corrupt?: boolean;
  },
): void {
  const full = join(parent, dir);
  mkdirSync(full, { recursive: true });
  if (opts.corrupt) {
    writeFileSync(join(full, 'manifest.json'), '{ not json');
    return;
  }
  writeFileSync(
    join(full, 'manifest.json'),
    JSON.stringify({
      schemaVersion: opts.schemaVersion ?? 1,
      snapshotId: `snap:${dir}`,
      kshetraId: opts.kshetraId ?? 'testk',
      createdAt: opts.createdAt,
      shreniBuild: {
        version: opts.version ?? '0.1.0',
        commit: opts.commit === undefined ? 'abcdef1234' : opts.commit,
        dirty: opts.dirty ?? false,
        builtAt: null,
      },
      repoPath: '/x',
      beads: {
        headSha: null,
        lastDoltCommit: null,
        beadCount: opts.beadCount ?? 3,
        memoryCount: opts.memoryCount ?? 1,
        openCount: 2,
        closedCount: 1,
        beadIdHash: opts.beadIdHash ?? 'sha256:aaaa0000',
      },
      rag: { present: false, sizeBytes: 0 },
      locations: [],
      labels: opts.labels ?? {},
    }),
  );
}

function capture(fn: () => void): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation(m => void logs.push(String(m)));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return logs.join('\n');
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('shreni snapshots list', () => {
  it('lists snapshots newest-first with counts, labels, build and short hash', () => {
    writeSnap(ROOT, '2026-09-20-100000', { createdAt: '2026-09-20T10:00:00.000Z', beadCount: 5, labels: { stage: 'a' } });
    writeSnap(ROOT, '2026-09-21-100000', { createdAt: '2026-09-21T10:00:00.000Z', beadCount: 7, dirty: true });

    const out = capture(() => runSnapshots(ctx(['list', ROOT])));
    const lines = out.split('\n').filter(l => l.trim());
    // Header + 2 rows.
    expect(lines[0]).toContain('CREATED');
    // Newest (the 21st) row comes before the 20th.
    const i21 = lines.findIndex(l => l.includes('2026-09-21-100000'));
    const i20 = lines.findIndex(l => l.includes('2026-09-20-100000'));
    expect(i21).toBeGreaterThan(0);
    expect(i21).toBeLessThan(i20);
    expect(out).toContain('stage=a');
    expect(out).toContain('(dirty)');
    expect(out).toContain('aaaa0000'); // short beadIdHash, sha256: stripped
  });

  it('marks rows sharing a beadIdHash with the same state marker', () => {
    writeSnap(ROOT, 's1', { createdAt: '2026-09-21T10:00:00.000Z', beadIdHash: 'sha256:same' });
    writeSnap(ROOT, 's2', { createdAt: '2026-09-21T11:00:00.000Z', beadIdHash: 'sha256:same' });
    writeSnap(ROOT, 's3', { createdAt: '2026-09-21T12:00:00.000Z', beadIdHash: 'sha256:different' });

    const rows = JSON.parse(capture(() => runSnapshots(ctx(['list', ROOT, '--json']))));
    const s1 = rows.find((r: { dir: string }) => r.dir === 's1');
    const s2 = rows.find((r: { dir: string }) => r.dir === 's2');
    const s3 = rows.find((r: { dir: string }) => r.dir === 's3');
    expect(s1.stateMarker).toBeTruthy();
    expect(s1.stateMarker).toBe(s2.stateMarker); // shared state → shared marker
    expect(s3.stateMarker).toBe(''); // unique state → no marker
  });

  it('filters by --kshetra', () => {
    writeSnap(ROOT, 'k1', { createdAt: '2026-09-21T10:00:00.000Z', kshetraId: 'alpha' });
    writeSnap(ROOT, 'k2', { createdAt: '2026-09-21T11:00:00.000Z', kshetraId: 'beta' });

    const rows = JSON.parse(capture(() => runSnapshots(ctx(['list', ROOT, '--kshetra', 'alpha', '--json']))));
    expect(rows).toHaveLength(1);
    expect(rows[0].kshetraId).toBe('alpha');
  });

  it('lists an unreadable or schema-newer manifest as a bad row instead of failing', () => {
    writeSnap(ROOT, 'good', { createdAt: '2026-09-21T10:00:00.000Z' });
    writeSnap(ROOT, 'corrupt', { createdAt: 'x', corrupt: true });
    writeSnap(ROOT, 'future', { createdAt: '2026-09-21T12:00:00.000Z', schemaVersion: 999 });

    const rows = JSON.parse(capture(() => runSnapshots(ctx(['list', ROOT, '--json']))));
    expect(rows).toHaveLength(3);
    const bad = rows.filter((r: { unreadable: boolean }) => r.unreadable);
    expect(bad).toHaveLength(2);
    // The good row is still fully populated.
    const good = rows.find((r: { dir: string }) => r.dir === 'good');
    expect(good.unreadable).toBe(false);
    expect(good.beadCount).toBe(3);
    // Unreadable rows sink below readable ones.
    expect(rows[0].dir).toBe('good');
  });

  it('skips subdirs without a manifest and reports an empty parent', () => {
    mkdirSync(join(ROOT, 'not-a-snapshot'), { recursive: true });
    writeFileSync(join(ROOT, 'not-a-snapshot', 'random.txt'), 'x');
    const out = capture(() => runSnapshots(ctx(['list', ROOT])));
    expect(out).toMatch(/no snapshots found/i);
  });

  it('resolves <parent> regardless of flag order (does not grab a flag value)', () => {
    writeSnap(ROOT, 'k1', { createdAt: '2026-09-21T10:00:00.000Z', kshetraId: 'alpha' });
    writeSnap(ROOT, 'k2', { createdAt: '2026-09-21T11:00:00.000Z', kshetraId: 'beta' });
    // --kshetra BEFORE the positional: a naive "first non-flag" scan would take
    // 'alpha' as the parent and blow up.
    const rows = JSON.parse(capture(() => runSnapshots(ctx(['list', '--kshetra', 'alpha', ROOT, '--json']))));
    expect(rows).toHaveLength(1);
    expect(rows[0].kshetraId).toBe('alpha');
  });

  it('rejects a non-list subcommand', () => {
    expect(() => runSnapshots(ctx(['bogus']))).toThrow(/Usage/);
  });
});
