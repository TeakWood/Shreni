import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config.js';
import {
  resolveTestCommand,
  resolveLintCommand,
  resolveCoverageCommand,
  splitCommand,
} from '../kshetra/toolchain.js';
import type { HealthStatus } from './health.js';
import type { LintResult } from './lint.js';

const execFileAsync = promisify(execFile);

export type GateLevel = 'block' | 'warn';
export type GateName = 'test' | 'lint' | 'coverage' | 'diffSize';

export interface GateResult {
  gate: GateName;
  level: GateLevel;
  passed: boolean;
  skipped: boolean;
  // Structured, per-gate explanation routed back to Silpi on a block failure
  // (or surfaced as a warning), including the exact command to reproduce.
  reason: string;
}

export interface GatesOutcome {
  // True when no block-level gate failed (warn failures don't block).
  passed: boolean;
  blockers: GateResult[];
  warnings: GateResult[];
  results: GateResult[];
}

export interface CoverageResult {
  passed: boolean;
  skipped: boolean;
  raw: string;
}

// Run the resolved coverage command (mirroring runLintGate). An empty resolved
// command means the Kshetra has no coverage step — a visible, logged skip.
// Resolves (never rejects); a non-zero exit yields passed=false.
export async function runCoverageGate(kshetra: KshetraConfig): Promise<CoverageResult> {
  const [cmd, ...args] = splitCommand(resolveCoverageCommand(kshetra));
  if (!cmd) {
    console.warn(`[gates] ${kshetra.id}: no coverage command configured — coverage gate skipped`);
    return { passed: true, skipped: true, raw: '(no coverage command configured — coverage gate skipped)' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: kshetra.repo.path,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { passed: true, skipped: false, raw: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
    return { passed: false, skipped: false, raw };
  }
}

export interface DiffSize {
  files: number;
  lines: number; // insertions + deletions
}

// Measure the bead branch's diff against main via git shortstat. Best-effort:
// a git failure returns null and the diffSize gate skips (logged) — a broken
// measurement must never wedge dispatch.
export async function measureDiffSize(
  kshetra: KshetraConfig,
  branch: string,
): Promise<DiffSize | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', `${kshetra.repo.mainBranch}...${branch}`, '--shortstat'],
      { cwd: kshetra.repo.path, maxBuffer: 10 * 1024 * 1024 },
    );
    // " 3 files changed, 10 insertions(+), 2 deletions(-)" — either term may be absent.
    const files = Number(stdout.match(/(\d+) files? changed/)?.[1] ?? 0);
    const insertions = Number(stdout.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0);
    const deletions = Number(stdout.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0);
    return { files, lines: insertions + deletions };
  } catch (err) {
    console.warn(
      `[gates] ${kshetra.id}: could not measure diff size for ${branch} — diffSize gate skipped (${(err as Error).message})`,
    );
    return null;
  }
}

// Hard gates cannot be softened: gates.test/lint at 'warn' is clamped back to
// block (additive-stricter — config may only tighten, never waive).
function effectiveLevel(gate: GateName, configured: GateLevel): GateLevel {
  if (gate === 'test' || gate === 'lint') return 'block';
  return configured;
}

// Evaluate the configurable gates at the dispatch decision point. test/lint
// consume the already-measured health/lint results (no re-run); coverage runs
// its resolved toolchain command here. A failing block gate lands in blockers
// (caller REJECTs with the per-gate reasons); a failing warn gate lands in
// warnings (surfaced, non-blocking). A gate whose command resolves empty is a
// skip: passed, never a blocker or warning.
export async function evaluateGates(
  kshetra: KshetraConfig,
  health: HealthStatus,
  lint: LintResult,
  branch: string,
): Promise<GatesOutcome> {
  const levels = kshetra.gates;
  const [coverage, diffSize] = await Promise.all([
    runCoverageGate(kshetra),
    measureDiffSize(kshetra, branch),
  ]);
  const { maxFiles, maxLines } = levels.diffSize;
  const diffOk =
    diffSize === null || (diffSize.files <= maxFiles && diffSize.lines <= maxLines);

  const failCountLabel =
    health.failCount >= 0 ? `${health.failCount} failing` : 'fail count unknown';
  const results: GateResult[] = [
    {
      gate: 'test',
      level: effectiveLevel('test', levels.test.level),
      passed: health.green,
      skipped: false,
      reason: health.green
        ? 'tests green'
        : `Test gate failed (${failCountLabel}, accepted baseline ${health.baseline}) — ` +
          `run \`${resolveTestCommand(kshetra)}\` and fix the failures.`,
    },
    {
      gate: 'lint',
      level: effectiveLevel('lint', levels.lint.level),
      passed: lint.passed,
      skipped: lint.skipped,
      reason: lint.passed
        ? lint.skipped
          ? 'lint skipped (no command configured)'
          : 'lint clean'
        : `Lint gate failed — run \`${resolveLintCommand(kshetra)}\` and fix the reported problems.`,
    },
    {
      gate: 'coverage',
      level: effectiveLevel('coverage', levels.coverage.level),
      passed: coverage.passed,
      skipped: coverage.skipped,
      reason: coverage.passed
        ? coverage.skipped
          ? 'coverage skipped (no command configured)'
          : 'coverage passed'
        : `Coverage gate failed — run \`${resolveCoverageCommand(kshetra)}\` and address the shortfall.`,
    },
    {
      gate: 'diffSize',
      level: effectiveLevel('diffSize', levels.diffSize.level),
      passed: diffOk,
      skipped: diffSize === null,
      reason: diffOk
        ? diffSize === null
          ? 'diff size skipped (could not measure)'
          : 'diff size within limits'
        : `Diff size gate failed — ${diffSize!.files} files / ${diffSize!.lines} changed lines ` +
          `exceeds the limit (${maxFiles} files / ${maxLines} lines). Reduce the diff to the ` +
          `minimal change for this task; split unrelated work out.`,
    },
  ];

  const failing = results.filter(r => !r.passed);
  const blockers = failing.filter(r => r.level === 'block');
  const warnings = failing.filter(r => r.level === 'warn');
  return { passed: blockers.length === 0, blockers, warnings, results };
}
