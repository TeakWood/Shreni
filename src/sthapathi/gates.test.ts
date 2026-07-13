import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { HealthStatus } from './health.js';
import type { LintResult } from './lint.js';

// Mock execFile (callback-style, as promisify expects).
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => (mockExecFile as (...a: unknown[]) => void)(...args),
}));

const { evaluateGates, runCoverageGate } = await import('./gates.js');

function ksh(
  stack: Partial<KshetraConfig['stack']> & { language: string },
  gates?: Partial<KshetraConfig['gates']>,
): KshetraConfig {
  return {
    id: 'myapp',
    repo: { path: '/projects/myapp', mainBranch: 'main' },
    stack,
    gates: {
      test: { level: 'block' },
      lint: { level: 'block' },
      coverage: { level: 'warn' },
      diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
      ...gates,
    },
  } as unknown as KshetraConfig;
}

const greenHealth: HealthStatus = { green: true, failCount: 0, baseline: 0, sha: 'abc' };
const redHealth: HealthStatus = { green: false, failCount: 3, baseline: 0, sha: 'abc' };
const cleanLint: LintResult = { passed: true, skipped: false, raw: '' };
const dirtyLint: LintResult = { passed: false, skipped: false, raw: '3 problems' };

// Route the exec mock by leading binary: 'git' serves the diffSize measurement
// (shortstat output), anything else is the coverage command.
function execRoutes(opts: { coverage?: 'pass' | 'fail'; gitStdout?: string; gitFails?: boolean } = {}): void {
  const { coverage = 'pass', gitStdout = '', gitFails = false } = opts;
  mockExecFile.mockImplementation((cmd, _args, _opts, cb: (e: unknown, r?: unknown) => void) => {
    if (cmd === 'git') {
      if (gitFails) cb(Object.assign(new Error('git failed'), {}));
      else cb(null, { stdout: gitStdout, stderr: '' });
      return;
    }
    if (coverage === 'fail') cb(Object.assign(new Error('exit 1'), { stdout: 'coverage below threshold', stderr: '' }));
    else cb(null, { stdout: 'all covered', stderr: '' });
  });
}
function execResolves(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((cmd, _args, _opts, cb: (e: unknown, r?: unknown) => void) => {
    cb(null, { stdout: cmd === 'git' ? '' : stdout, stderr: cmd === 'git' ? '' : stderr });
  });
}
function execRejects(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: (e: unknown) => void) => {
    cb(Object.assign(new Error('exit 1'), { stdout, stderr }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: everything succeeds with an empty diff, so tests that don't care
  // about exec behaviour never hang on an unimplemented mock.
  execRoutes();
});

describe('runCoverageGate', () => {
  it('passes when the resolved coverage command exits 0', async () => {
    execResolves('all covered');
    const r = await runCoverageGate(ksh({ language: 'typescript' }));
    expect(r).toEqual({ passed: true, skipped: false, raw: 'all covered' });
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('pnpm');
    expect(args).toEqual(['test:coverage']);
  });

  it('fails when the coverage command exits non-zero', async () => {
    execRejects('coverage 62% < 80%', '');
    const r = await runCoverageGate(ksh({ language: 'typescript' }));
    expect(r.passed).toBe(false);
    expect(r.raw).toContain('62%');
  });

  it('skips-and-logs when no coverage command resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runCoverageGate(ksh({ language: 'typescript', coverageCommand: '' }));
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coverage gate skipped'));
    warn.mockRestore();
  });
});

describe('evaluateGates', () => {
  it('all green → passed, no blockers or warnings', async () => {
    execResolves();
    const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
    expect(o.passed).toBe(true);
    expect(o.blockers).toEqual([]);
    expect(o.warnings).toEqual([]);
    expect(o.results).toHaveLength(4);
  });

  it('failing block gate → blocker with a per-gate reason naming the command', async () => {
    execResolves();
    const o = await evaluateGates(ksh({ language: 'typescript' }), redHealth, dirtyLint, 'bead-1/x');
    expect(o.passed).toBe(false);
    expect(o.blockers.map(b => b.gate)).toEqual(['test', 'lint']);
    expect(o.blockers[0].reason).toContain('3 failing');
    expect(o.blockers[0].reason).toContain('pnpm test');
    expect(o.blockers[1].reason).toContain('pnpm lint');
  });

  it('failing warn gate (coverage default) → warning, does not block', async () => {
    execRejects('coverage below threshold');
    const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
    expect(o.passed).toBe(true);
    expect(o.blockers).toEqual([]);
    expect(o.warnings.map(w => w.gate)).toEqual(['coverage']);
    expect(o.warnings[0].reason).toContain('pnpm test:coverage');
  });

  it('coverage raised to block → failing coverage blocks', async () => {
    execRejects('coverage below threshold');
    const o = await evaluateGates(
      ksh({ language: 'typescript' }, { coverage: { level: 'block' } }),
      greenHealth,
      cleanLint,
      'bead-1/x',
    );
    expect(o.passed).toBe(false);
    expect(o.blockers.map(b => b.gate)).toEqual(['coverage']);
  });

  it('test/lint cannot be softened to warn (clamped to block)', async () => {
    execResolves();
    const o = await evaluateGates(
      ksh({ language: 'typescript' }, { test: { level: 'warn' }, lint: { level: 'warn' } }),
      redHealth,
      dirtyLint,
      'bead-1/x',
    );
    expect(o.passed).toBe(false);
    expect(o.blockers.map(b => b.gate)).toEqual(['test', 'lint']);
    expect(o.warnings).toEqual([]);
  });

  it('missing coverage command → skip: neither blocker nor warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = await evaluateGates(
      ksh({ language: 'typescript', coverageCommand: '' }, { coverage: { level: 'block' } }),
      greenHealth,
      cleanLint,
      'bead-1/x',
    );
    expect(o.passed).toBe(true);
    expect(o.blockers).toEqual([]);
    expect(o.warnings).toEqual([]);
    const cov = o.results.find(r => r.gate === 'coverage');
    expect(cov?.skipped).toBe(true);
    warn.mockRestore();
  });

  describe('diffSize gate', () => {
    it('passes when the diff is within limits', async () => {
      execRoutes({ gitStdout: ' 3 files changed, 100 insertions(+), 20 deletions(-)' });
      const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
      expect(o.passed).toBe(true);
      expect(o.warnings).toEqual([]);
    });

    it('oversized diff at default warn level → warning, does not block', async () => {
      execRoutes({ gitStdout: ' 41 files changed, 2000 insertions(+), 100 deletions(-)' });
      const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
      expect(o.passed).toBe(true);
      expect(o.warnings.map(w => w.gate)).toEqual(['diffSize']);
      expect(o.warnings[0].reason).toContain('41 files / 2100 changed lines');
      expect(o.warnings[0].reason).toContain('40 files / 1500 lines');
    });

    it('oversized diff raised to block → blocker', async () => {
      execRoutes({ gitStdout: ' 2 files changed, 1600 insertions(+)' });
      const o = await evaluateGates(
        ksh({ language: 'typescript' }, { diffSize: { level: 'block', maxFiles: 40, maxLines: 1500 } }),
        greenHealth,
        cleanLint,
        'bead-1/x',
      );
      expect(o.passed).toBe(false);
      expect(o.blockers.map(b => b.gate)).toEqual(['diffSize']);
    });

    it('custom limits are honoured', async () => {
      execRoutes({ gitStdout: ' 6 files changed, 10 insertions(+)' });
      const o = await evaluateGates(
        ksh({ language: 'typescript' }, { diffSize: { level: 'warn', maxFiles: 5, maxLines: 1500 } }),
        greenHealth,
        cleanLint,
        'bead-1/x',
      );
      expect(o.warnings.map(w => w.gate)).toEqual(['diffSize']);
    });

    it('git failure → measurement skipped, never blocks dispatch', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      execRoutes({ gitFails: true });
      const o = await evaluateGates(
        ksh({ language: 'typescript' }, { diffSize: { level: 'block', maxFiles: 40, maxLines: 1500 } }),
        greenHealth,
        cleanLint,
        'bead-1/x',
      );
      expect(o.passed).toBe(true);
      const ds = o.results.find(r => r.gate === 'diffSize');
      expect(ds?.skipped).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('diffSize gate skipped'));
      warn.mockRestore();
    });
  });
});
