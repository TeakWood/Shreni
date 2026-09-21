import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readBeadStats,
  readLastDoltCommit,
  copyTree,
  moveTree,
  pathSizeBytes,
  readManifest,
  MANIFEST_FILENAME,
} from './snapshot.js';

const dir = join(tmpdir(), `shreni-snapshot-test-${process.pid}`);

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeIssues(lines: object[]): string {
  const beads = join(dir, 'beads');
  mkdirSync(beads, { recursive: true });
  writeFileSync(join(beads, 'issues.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return beads;
}

describe('readBeadStats', () => {
  it('counts beads and memories from _type, and open/closed from status', () => {
    const beads = writeIssues([
      { _type: 'issue', id: 'k-1', status: 'open' },
      { _type: 'issue', id: 'k-2', status: 'closed' },
      { _type: 'issue', id: 'k-3', status: 'in_progress' },
      { _type: 'memory', key: 'm1', value: 'x' },
      { _type: 'memory', key: 'm2', value: 'y' },
    ]);
    const s = readBeadStats(beads);
    expect(s.beadCount).toBe(3);
    expect(s.memoryCount).toBe(2);
    expect(s.closedCount).toBe(1);
    expect(s.openCount).toBe(2); // open + in_progress are both non-closed
  });

  it('bead-id hash is stable and order-independent', () => {
    const a = readBeadStats(
      writeIssues([
        { _type: 'issue', id: 'k-2', status: 'open' },
        { _type: 'issue', id: 'k-1', status: 'open' },
      ]),
    );
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const b = readBeadStats(
      writeIssues([
        { _type: 'issue', id: 'k-1', status: 'closed' }, // status differs; ids same
        { _type: 'issue', id: 'k-2', status: 'closed' },
      ]),
    );
    expect(a.beadIdHash).toBe(b.beadIdHash);
    expect(a.beadIdHash).toMatch(/^sha256:/);
  });

  it('different id sets produce different hashes', () => {
    const a = readBeadStats(writeIssues([{ _type: 'issue', id: 'k-1', status: 'open' }]));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const b = readBeadStats(writeIssues([{ _type: 'issue', id: 'k-9', status: 'open' }]));
    expect(a.beadIdHash).not.toBe(b.beadIdHash);
  });

  it('missing issues.jsonl yields zero counts, not an error', () => {
    const beads = join(dir, 'empty-beads');
    mkdirSync(beads, { recursive: true });
    const s = readBeadStats(beads);
    expect(s).toMatchObject({ beadCount: 0, memoryCount: 0, openCount: 0, closedCount: 0 });
  });
});

describe('readLastDoltCommit', () => {
  it('reads last_dolt_commit from export-state.json', () => {
    const beads = join(dir, 'beads');
    mkdirSync(beads, { recursive: true });
    writeFileSync(join(beads, 'export-state.json'), JSON.stringify({ last_dolt_commit: 'abc123' }));
    expect(readLastDoltCommit(beads)).toBe('abc123');
  });
  it('returns null when the file is missing or malformed', () => {
    expect(readLastDoltCommit(join(dir, 'nope'))).toBeNull();
    const beads = join(dir, 'beads');
    mkdirSync(beads, { recursive: true });
    writeFileSync(join(beads, 'export-state.json'), 'not json');
    expect(readLastDoltCommit(beads)).toBeNull();
  });
});

describe('copyTree + pathSizeBytes', () => {
  it('copies a directory tree and reports its recursive size', () => {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'hello'); // 5 bytes
    writeFileSync(join(src, 'sub', 'b.txt'), 'world!'); // 6 bytes
    const dest = join(dir, 'dest');
    copyTree(src, dest);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(dest, 'sub', 'b.txt'), 'utf8')).toBe('world!');
    expect(pathSizeBytes(src)).toBe(11);
  });

  it('copies a single file', () => {
    const src = join(dir, 'one.txt');
    writeFileSync(src, 'x'.repeat(42));
    const dest = join(dir, 'copy.txt');
    copyTree(src, dest);
    expect(existsSync(dest)).toBe(true);
    expect(pathSizeBytes(dest)).toBe(42);
  });

  it('pathSizeBytes is 0 for a missing path', () => {
    expect(pathSizeBytes(join(dir, 'ghost'))).toBe(0);
  });
});

describe('moveTree', () => {
  it('moves a directory, leaving nothing behind at the source', () => {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'data');
    const dest = join(dir, 'archive', 'moved');
    moveTree(src, dest);
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('data');
  });
});

describe('readManifest', () => {
  it('throws a clear error when there is no manifest', () => {
    expect(() => readManifest(dir)).toThrow(/no manifest\.json/i);
  });
  it('throws on a corrupt manifest', () => {
    writeFileSync(join(dir, MANIFEST_FILENAME), '{ broken');
    expect(() => readManifest(dir)).toThrow(/corrupt/i);
  });
  it('parses a valid manifest', () => {
    writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify({ kshetraId: 'k', schemaVersion: 1 }));
    expect(readManifest(dir)).toMatchObject({ kshetraId: 'k', schemaVersion: 1 });
  });
});
