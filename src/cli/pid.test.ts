import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync } from 'fs';

// Override homedir to a temp location before importing the module
const tmpDir = join(tmpdir(), `shreni-pid-test-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpDir };
});

const { writePid, readPid, clearPid, isAlive, workerPidPath, kshetraDir } = await import('./pid');

const KID = 'sishya';

describe('workerPidPath', () => {
  it('resolves under homedir/.shreni/kshetra/<id>', () => {
    const p = workerPidPath(KID);
    expect(p).toContain('.shreni');
    expect(p).toContain(join('kshetra', KID));
    expect(p).toContain('worker.pid');
  });

  it('isolates each kshetra into its own dir', () => {
    expect(kshetraDir('a')).not.toBe(kshetraDir('b'));
  });
});

describe('writePid / readPid', () => {
  afterEach(() => {
    try { clearPid(KID); } catch { /* ignore */ }
  });

  it('round-trips a PID', () => {
    writePid(KID, 12345);
    expect(readPid(KID)).toBe(12345);
  });

  it('readPid returns null when no file exists', () => {
    expect(readPid('does-not-exist')).toBeNull();
  });

  it('readPid returns null for non-numeric content', () => {
    writePid(KID, 1); // ensures dir exists
    writeFileSync(workerPidPath(KID), 'not-a-number', 'utf8');
    expect(readPid(KID)).toBeNull();
  });
});

describe('clearPid', () => {
  it('removes the PID file', () => {
    writePid(KID, 99);
    clearPid(KID);
    expect(readPid(KID)).toBeNull();
  });

  it('does not throw if file does not exist', () => {
    expect(() => clearPid('never-written')).not.toThrow();
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
