import { describe, it, expect, vi, beforeEach } from 'vitest';
import { performance } from 'perf_hooks';
import type { KshetraConfig } from '../kshetra/config.js';
import type { HealthStatus } from './health.js';
import type { LintResult } from './lint.js';

// Mock execFile (callback-style, as promisify expects).
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => (mockExecFile as (...a: unknown[]) => void)(...args),
}));

const { evaluateGates, runCoverageGate, effectiveLevel, judgeCoverage } = await import('./gates.js');

// An enforcement-ablated variant of a config (epic 8wi).
function ablatedEnforcement(k: KshetraConfig): KshetraConfig {
  return { ...k, ablation: { enforcement: 'off' } } as unknown as KshetraConfig;
}

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
    expect(r).toEqual({ passed: true, skipped: false, raw: 'all covered', summary: null });
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

const SUMMARY_OUT = 'Statements   : 91.5% ( 915/1000 )\nBranches     : 80% ( 80/100 )\nFunctions    : 95% ( 95/100 )\nLines        : 92% ( 920/1000 )\n';

describe('coverage numbers + optional minimum (Shreni-beads-06z)', () => {
  it('runCoverageGate parses the printed summary', async () => {
    execResolves(SUMMARY_OUT);
    const r = await runCoverageGate(ksh({ language: 'typescript' }));
    expect(r.summary).toEqual({ statements: 91.5, branches: 80, functions: 95, lines: 92 });
  });

  it('evaluateGates records the measured coverage on the coverage result, with the numbers in its reason', async () => {
    execResolves(SUMMARY_OUT);
    const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
    const cov = o.results.find(r => r.gate === 'coverage')!;
    expect(cov.passed).toBe(true);
    expect(cov.coverage).toEqual({ statements: 91.5, branches: 80, functions: 95, lines: 92 });
    expect(cov.reason).toBe('coverage statements 91.5% · branches 80% · functions 95% · lines 92%');
    // No other gate carries coverage.
    expect(o.results.filter(r => r.coverage)).toHaveLength(1);
  });

  it('with no minimum, a passing command with no summary still passes — but says it added no signal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    execResolves('  1234 passing\n');
    const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
    const cov = o.results.find(r => r.gate === 'coverage')!;
    expect(cov.passed).toBe(true);
    expect(cov.coverage).toBeUndefined();
    expect(cov.reason).toContain('no recognisable coverage summary');
    expect(cov.reason).toContain('stack.coverageCommand: ""');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('adds no signal beyond the test gate'));
    warn.mockRestore();
  });

  it('a configured minimum fails the gate on a shortfall and names each metric', async () => {
    execResolves(SUMMARY_OUT);
    const o = await evaluateGates(
      ksh({ language: 'typescript' }, { coverage: { level: 'block', min: { lines: 90, branches: 85 } } } as never),
      greenHealth, cleanLint, 'bead-1/x',
    );
    expect(o.passed).toBe(false);
    expect(o.blockers.map(b => b.gate)).toEqual(['coverage']);
    expect(o.blockers[0].reason).toContain('branches 80% < 85%');
    expect(o.blockers[0].reason).not.toContain('lines');
    // The measured numbers are still recorded on a failing gate.
    expect(o.blockers[0].coverage).toMatchObject({ branches: 80 });
  });

  it('a configured minimum met → pass', async () => {
    execResolves(SUMMARY_OUT);
    const o = await evaluateGates(
      ksh({ language: 'typescript' }, { coverage: { level: 'block', min: { lines: 90 } } } as never),
      greenHealth, cleanLint, 'bead-1/x',
    );
    expect(o.passed).toBe(true);
  });

  it('judgeCoverage: a minimum with no parseable summary fails loudly, never silently passes', () => {
    const v = judgeCoverage({ passed: true, skipped: false, raw: 'ok', summary: null }, { lines: 80 }, 'pnpm test:coverage');
    expect(v.passed).toBe(false);
    expect(v.noSignal).toBe(true);
    // Framed as the operator's configuration problem, not a task defect for Silpi.
    expect(v.reason).toContain('CONFIGURATION ISSUE');
    expect(v.reason).toContain('gates.coverage.min is set');
  });

  it('judgeCoverage: a minimum on a metric the tool did not report fails', () => {
    const v = judgeCoverage({ passed: true, skipped: false, raw: '', summary: { statements: 99 } }, { branches: 50 }, 'c');
    expect(v).toEqual({ passed: false, noSignal: false, reason: expect.stringContaining('branches not reported (minimum 50%)') });
  });

  it('judgeCoverage: a failing command fails exactly as before, whatever the numbers', () => {
    const v = judgeCoverage({ passed: false, skipped: false, raw: '', summary: { lines: 100 } }, undefined, 'pnpm test:coverage');
    expect(v.passed).toBe(false);
    expect(v.reason).toContain('pnpm test:coverage');
  });

  it('judgeCoverage: a skip stays a skip even with a minimum configured', () => {
    expect(judgeCoverage({ passed: true, skipped: true, raw: '', summary: null }, { lines: 80 }, '')).toEqual({
      passed: true, reason: 'coverage skipped (no command configured)', noSignal: false,
    });
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

  describe('per-gate durationMs (epic hto / Study A3)', () => {
    it('carries the passed test/lint timings and measures coverage/diffSize at their sites', async () => {
      execRoutes();
      const o = await evaluateGates(
        ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x',
        { healthMs: 4200, lintMs: 120 },
      );
      const by = Object.fromEntries(o.results.map(r => [r.gate, r.durationMs]));
      expect(by.test).toBe(4200);   // passed through from dispatch (measureHealth)
      expect(by.lint).toBe(120);    // passed through from dispatch (runLintGate)
      expect(typeof by.coverage).toBe('number'); // measured here
      expect(typeof by.diffSize).toBe('number'); // measured here
    });

    it('defaults test/lint durations to 0 when no timings are supplied', async () => {
      const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x');
      const test = o.results.find(r => r.gate === 'test');
      expect(test?.durationMs).toBe(0);
    });

    it('runs coverage and diffSize in parallel — their durations are not summed into the block time', async () => {
      // Both probes take ~40ms; under Promise.all the block wall time is ~max(40,40),
      // strictly less than the per-gate sum (~80ms). Real timers, generous margin.
      mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
        setTimeout(() => cb(null, { stdout: '', stderr: '' }), 40);
      });
      const start = performance.now();
      const o = await evaluateGates(ksh({ language: 'typescript' }), greenHealth, cleanLint, 'bead-1/x', { healthMs: 0, lintMs: 0 });
      const wall = performance.now() - start;
      const cov = o.results.find(r => r.gate === 'coverage')!.durationMs;
      const diff = o.results.find(r => r.gate === 'diffSize')!.durationMs;
      expect(cov).toBeGreaterThanOrEqual(30);
      expect(diff).toBeGreaterThanOrEqual(30);
      expect(wall).toBeLessThan(cov + diff); // parallel, not summed
    });
  });
});

describe('effectiveLevel — the single clamp site (epic 8wi / Study B1)', () => {
  it('clamps test/lint to block normally, and warns everything under enforcement ablation', () => {
    // Normal: test/lint clamp to block; coverage/diffSize keep configured level.
    expect(effectiveLevel('test', 'warn')).toBe('block');
    expect(effectiveLevel('lint', 'warn')).toBe('block');
    expect(effectiveLevel('coverage', 'warn')).toBe('warn');
    expect(effectiveLevel('coverage', 'block')).toBe('block');
    // Enforcement ablated: EVERY gate is warn, including the test/lint clamp.
    expect(effectiveLevel('test', 'block', true)).toBe('warn');
    expect(effectiveLevel('lint', 'block', true)).toBe('warn');
    expect(effectiveLevel('coverage', 'block', true)).toBe('warn');
  });
});

describe('evaluateGates under enforcement ablation (epic 8wi / Study B1)', () => {
  it('turns a failing blocking gate into a warning marked ablated — gates pass overall', async () => {
    execRoutes();
    const o = await evaluateGates(ablatedEnforcement(ksh({ language: 'typescript' })), redHealth, cleanLint, 'bead-1/x');
    expect(o.passed).toBe(true);      // enforcement removed → no blockers
    expect(o.blockers).toHaveLength(0);
    const test = o.results.find(r => r.gate === 'test')!;
    expect(test.level).toBe('warn');
    expect(test.passed).toBe(false);
    expect(test.ablations).toEqual(['enforcement']); // distinguishable from a configured warn
    expect(o.warnings.some(w => w.gate === 'test')).toBe(true);
  });

  it('does not mark a passing gate as ablated', async () => {
    execRoutes();
    const o = await evaluateGates(ablatedEnforcement(ksh({ language: 'typescript' })), greenHealth, cleanLint, 'bead-1/x');
    const test = o.results.find(r => r.gate === 'test')!;
    expect(test.passed).toBe(true);
    expect(test.ablations).toBeUndefined();
  });

  it('without the ablation, test/lint stay clamped to block (unchanged)', async () => {
    execRoutes();
    const o = await evaluateGates(ksh({ language: 'typescript' }), redHealth, cleanLint, 'bead-1/x');
    const test = o.results.find(r => r.gate === 'test')!;
    expect(test.level).toBe('block');
    expect(test.ablations).toBeUndefined();
    expect(o.passed).toBe(false); // test is a blocker
  });
});
