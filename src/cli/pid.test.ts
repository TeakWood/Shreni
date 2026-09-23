import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, utimesSync, existsSync } from 'fs';

// Override homedir to a temp location before importing the module
const tmpDir = join(tmpdir(), `shreni-pid-test-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpDir };
});

const {
  writePid, readPid, clearPid, isAlive, workerPidPath, kshetraDir,
  claimWorkerPid, releaseWorkerPid, looksLikeShreniProcess, claimForThisProcess,
} = await import('./pid');
const { spawn } = await import('child_process');

const KID = 'myapp';

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

// ── Worker ownership (Shreni-beads-4w0) ─────────────────────────────────────
describe('claimWorkerPid / releaseWorkerPid', () => {
  const K = 'own-test';
  afterEach(() => clearPid(K));

  it('claims an absent pidfile and writes the pid', () => {
    expect(claimWorkerPid(K, 4242, () => true)).toEqual({ ok: true });
    expect(readPid(K)).toBe(4242);
  });

  it('re-claiming its own pid is a no-op success (start writes it, the child claims it again)', () => {
    claimWorkerPid(K, 4242, () => true);
    expect(claimWorkerPid(K, 4242, () => true)).toEqual({ ok: true });
    expect(readPid(K)).toBe(4242);
  });

  it('refuses when a live worker owns it, naming the owner — and never overwrites it', () => {
    claimWorkerPid(K, 1111, () => true);
    expect(claimWorkerPid(K, 2222, () => true)).toEqual({ ok: false, ownerPid: 1111 });
    expect(readPid(K)).toBe(1111);
  });

  it('a stale pidfile from a crashed worker does not block a new one', () => {
    writePid(K, 1111);
    expect(claimWorkerPid(K, 2222, () => false)).toEqual({ ok: true });
    expect(readPid(K)).toBe(2222);
  });

  it('a garbage pidfile is reclaimed', () => {
    writeFileSync(workerPidPath(K), 'not-a-pid');
    expect(claimWorkerPid(K, 2222, () => true)).toEqual({ ok: true });
    expect(readPid(K)).toBe(2222);
  });

  it('release removes only its own claim, never a successor\'s', () => {
    claimWorkerPid(K, 1111, () => true);
    releaseWorkerPid(K, 9999);
    expect(readPid(K)).toBe(1111);
    releaseWorkerPid(K, 1111);
    expect(readPid(K)).toBeNull();
  });

  it('claimForThisProcess throws the refusal with the owner pid and how to proceed', () => {
    // A live Shreni-looking owner: this very process is always "ours", so use a
    // real child whose command line names __worker.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'shreni', '__worker'], { stdio: 'ignore' });
    try {
      writePid(K, child.pid!);
      expect(() => claimForThisProcess(K)).toThrow(new RegExp(`owned by a live worker \\(pid ${child.pid}\\).*shreni stop ${K}`));
      expect(readPid(K)).toBe(child.pid);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('after one claimer reclaims a stale pidfile, the next is refused — never a double owner', () => {
    writePid(K, 2 ** 22 + 777); // stale: only 1001 is a live worker below
    const live = (p: number) => p === 1001;
    expect(claimWorkerPid(K, 1001, live)).toEqual({ ok: true });
    expect(claimWorkerPid(K, 1002, live)).toEqual({ ok: false, ownerPid: 1001 });
    expect(readPid(K)).toBe(1001);
  });

  it('a leftover lock from a crashed claimer is broken after it goes stale', () => {
    const lock = `${workerPidPath(K)}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(claimWorkerPid(K, 3003, () => true)).toEqual({ ok: true });
    expect(existsSync(lock)).toBe(false);
  });

  it('claimForThisProcess registers this process and its release clears it', () => {
    const release = claimForThisProcess(K);
    expect(readPid(K)).toBe(process.pid);
    release();
    expect(readPid(K)).toBeNull();
  });
});

describe('looksLikeShreniProcess (recycled-pid guard)', () => {
  it.skipIf(process.platform === 'win32')('needs a Shreni entry point AND a worker subcommand — a mere "shreni" substring is not enough', async () => {
    // e.g. a Claude/editor process whose args merely mention the repo.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '/projects/Shreni/README.md'], { stdio: 'ignore' });
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'shreni', 'drain', '--kshetra', 'x'], { stdio: 'ignore' });
    try {
      await Promise.all([new Promise(r => other.once('spawn', r)), new Promise(r => worker.once('spawn', r))]);
      expect(looksLikeShreniProcess(other.pid!)).toBe(false);
      expect(looksLikeShreniProcess(worker.pid!)).toBe(true);
    } finally {
      other.kill('SIGKILL');
      worker.kill('SIGKILL');
    }
  });

  it('is true for this process', () => {
    expect(looksLikeShreniProcess(process.pid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('is false for an unrelated live process, so its pid cannot block a worker', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise(r => child.once('spawn', r));
      expect(isAlive(child.pid!)).toBe(true);
      expect(looksLikeShreniProcess(child.pid!)).toBe(false);
      // …so a stale pidfile naming it is reclaimed by the default liveness check.
      writePid('recycled', child.pid!);
      expect(claimWorkerPid('recycled', 5555)).toEqual({ ok: true });
      clearPid('recycled');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
