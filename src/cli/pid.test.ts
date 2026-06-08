import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';

// Override PID_PATH to a temp location before importing the module
const tmpDir = join(tmpdir(), `shreni-pid-test-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
const TEST_PID_PATH = join(tmpDir, 'shreni.pid');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpDir };
});

const { writePid, readPid, clearPid, isAlive, PID_PATH } = await import('./pid');

describe('PID_PATH', () => {
  it('resolves under homedir/.shreni', () => {
    expect(PID_PATH).toContain('.shreni');
    expect(PID_PATH).toContain('shreni.pid');
  });
});

describe('writePid / readPid', () => {
  afterEach(() => {
    try { clearPid(); } catch { /* ignore */ }
  });

  it('round-trips a PID', () => {
    writePid(12345);
    expect(readPid()).toBe(12345);
  });

  it('readPid returns null when no file exists', () => {
    expect(readPid()).toBeNull();
  });

  it('readPid returns null for non-numeric content', () => {
    mkdirSync(require('path').dirname(TEST_PID_PATH), { recursive: true });
    writeFileSync(PID_PATH, 'not-a-number', 'utf8');
    expect(readPid()).toBeNull();
  });
});

describe('clearPid', () => {
  it('removes the PID file', () => {
    writePid(99);
    clearPid();
    expect(readPid()).toBeNull();
  });

  it('does not throw if file does not exist', () => {
    expect(() => clearPid()).not.toThrow();
  });
});

describe('isAlive', () => {
  it('returns true for the current process PID', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('returns false for a PID that does not exist', () => {
    // PID 2147483647 is essentially guaranteed to not exist
    expect(isAlive(2147483647)).toBe(false);
  });
});