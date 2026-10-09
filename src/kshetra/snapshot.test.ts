import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  copyTree,
  moveTree,
  pathSizeBytes,
  readManifest,
  computeSnapshotId,
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

describe('computeSnapshotId', () => {
  it('is stable, key-order independent, and ignores its own snapshotId field', () => {
    const a = computeSnapshotId({ kshetraId: 'k', schemaVersion: 1, createdAt: 't' } as never);
    const b = computeSnapshotId({ schemaVersion: 1, createdAt: 't', kshetraId: 'k' } as never);
    const c = computeSnapshotId({ kshetraId: 'k', schemaVersion: 1, createdAt: 't', snapshotId: 'whatever' } as never);
    expect(a).toMatch(/^snap:[0-9a-f]{32}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
  it('changes when the content changes', () => {
    const a = computeSnapshotId({ kshetraId: 'k', createdAt: 't1' } as never);
    const b = computeSnapshotId({ kshetraId: 'k', createdAt: 't2' } as never);
    expect(a).not.toBe(b);
  });
});
