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
import { timed } from './timing.js';
import { isAblated, type AblationKey } from '../kshetra/ablation.js';
import { parseCoverageSummary, formatCoverageSummary, COVERAGE_METRICS, type CoverageSummary } from './coverage-summary.js';

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
  // Monotonic time this gate's work took (epic hto / Study A3). Attribution-only
  // — carried through to gate_result.durationMs; never summed into a round total
  // (parallel gates overlap). test/lint run before evaluateGates so their timings
  // are passed in; coverage/diffSize are measured here. A skipped gate records
  // whatever it spent (usually ~0).
  durationMs: number;
  // The generic ablation marker (epic 8wi / Study B1): present (['enforcement'])
  // ONLY on a FAILING gate that WOULD have blocked but was downgraded to warn by
  // the enforcement ablation — so it is distinguishable from a gate configured as
  // warn. Absent otherwise.
  ablations?: AblationKey[];
  // Coverage gate only (Shreni-beads-06z): the percentages the coverage command
  // printed, recorded on gate_result. Absent when nothing parseable was printed.
  coverage?: CoverageSummary;
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
  // Parsed from `raw` (Shreni-beads-06z); null when the output carried no
  // recognisable coverage summary (or the gate was skipped).
  summary: CoverageSummary | null;
}

// Run the resolved coverage command (mirroring runLintGate). An empty resolved
// command means the Kshetra has no coverage step — a visible, logged skip.
// Resolves (never rejects); a non-zero exit yields passed=false.
export async function runCoverageGate(kshetra: KshetraConfig): Promise<CoverageResult> {
  const [cmd, ...args] = splitCommand(resolveCoverageCommand(kshetra));
  if (!cmd) {
    console.warn(`[gates] ${kshetra.id}: no coverage command configured — coverage gate skipped`);
    return { passed: true, skipped: true, raw: '(no coverage command configured — coverage gate skipped)', summary: null };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: kshetra.repo.path,
      maxBuffer: 32 * 1024 * 1024,
    });
    const raw = stdout + stderr;
    return { passed: true, skipped: false, raw, summary: parseCoverageSummary(raw) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
    return { passed: false, skipped: false, raw, summary: parseCoverageSummary(raw) };
  }
}

// Decide the coverage gate from the command result and the optional configured
// minimums (Shreni-beads-06z). Pure, so the verdict logic is testable without a
// subprocess. With no `min` configured the verdict is exactly the pre-06z one
// (did the command exit 0) — only the reason gains the measured numbers.
export function judgeCoverage(
  coverage: CoverageResult,
  min: KshetraConfig['gates']['coverage']['min'],
  command: string,
): { passed: boolean; reason: string; noSignal: boolean } {
  if (coverage.skipped) return { passed: true, reason: 'coverage skipped (no command configured)', noSignal: false };
  if (!coverage.passed) {
    return { passed: false, reason: `Coverage gate failed — run \`${command}\` and address the shortfall.`, noSignal: false };
  }
  const s = coverage.summary;
  const required = COVERAGE_METRICS.filter(k => min?.[k] !== undefined);
  if (!s) {
    // The command succeeded but printed no coverage summary: it re-ran the suite
    // and added no signal beyond the test gate. Surface that — it is a full
    // suite's cost for nothing — rather than calling it a coverage pass.
    const noSignal =
      `\`${command}\` printed no recognisable coverage summary, so it adds no signal beyond the test gate ` +
      `(a second full suite run). Enable a text/text-summary coverage reporter, or set ` +
      `stack.coverageCommand: "" to skip the gate.`;
    // With a minimum configured this cannot pass (never a silent pass), but it is
    // a HARNESS CONFIGURATION problem, not a task defect: say so, so the agent
    // does not rework the repo's coverage tooling. A block-level gate therefore
    // rejects every round and the bead escalates to a human — the right owner.
    return required.length
      ? {
          passed: false,
          reason:
            `Coverage gate failed — CONFIGURATION ISSUE, not a defect in this task: gates.coverage.min is set but ` +
            `${noSignal} Do not change the project's coverage tooling for this task; the operator must fix the ` +
            `kshetra configuration.`,
          noSignal: true,
        }
      : { passed: true, reason: `coverage command passed, but ${noSignal}`, noSignal: true };
  }
  const shortfalls: string[] = [];
  for (const k of required) {
    const actual = s[k];
    if (actual === undefined) shortfalls.push(`${k} not reported (minimum ${min![k]}%)`);
    else if (actual < min![k]!) shortfalls.push(`${k} ${actual}% < ${min![k]}%`);
  }
  if (shortfalls.length) {
    return {
      passed: false,
      reason: `Coverage gate failed — ${shortfalls.join('; ')}. Run \`${command}\` and add tests for the uncovered code.`,
      noSignal: false,
    };
  }
  return { passed: true, reason: `coverage ${formatCoverageSummary(s)}`, noSignal: false };
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
// block (additive-stricter — config may only tighten, never waive). Exported so
// the lot manifest (epic yrk / Study B2) records the EFFECTIVE gate level a lot
// enforced — the same clamp, from one source, never re-implemented.
//
// The enforcement ablation (epic 8wi / Study B1) is applied HERE, the ONE place
// the effective level is decided: when active, EVERY gate is warn (including the
// test/lint clamp) — enforcement is removed, but gates still run and their
// failures still surface (dispatch routes warn failures to the bead + next round).
export function effectiveLevel(
  gate: GateName,
  configured: GateLevel,
  enforcementAblated = false,
): GateLevel {
  if (enforcementAblated) return 'warn';
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
  // Monotonic durations of the test (measureHealth) and lint (runLintGate) gates,
  // which run in dispatch.ts BEFORE this call (epic hto / Study A3). Attribution-
  // only; carried onto the corresponding GateResult.durationMs. Optional so
  // callers/tests that don't time them get 0.
  timings: { healthMs?: number; lintMs?: number } = {},
): Promise<GatesOutcome> {
  const levels = kshetra.gates;
  // Enforcement ablation (epic 8wi / Study B1): when active, every gate's effective
  // level is warn — gates still run and failures still surface, only blocking is
  // removed. Computed once and threaded through effectiveLevel (the one clamp site).
  const enfAblated = isAblated(kshetra, 'enforcement');
  // Time coverage and diff-size at THEIR sites. They run under Promise.all, so
  // their durations overlap and must never be summed into a round total.
  const [coverageT, diffSizeT] = await Promise.all([
    timed(() => runCoverageGate(kshetra)),
    timed(() => measureDiffSize(kshetra, branch)),
  ]);
  const coverage = coverageT.result;
  const coverageVerdict = judgeCoverage(coverage, levels.coverage.min, resolveCoverageCommand(kshetra));
  if (coverageVerdict.noSignal) {
    console.warn(`[gates] ${kshetra.id}: ${coverageVerdict.reason}`);
  }
  const diffSize = diffSizeT.result;
  const { maxFiles, maxLines } = levels.diffSize;
  const diffOk =
    diffSize === null || (diffSize.files <= maxFiles && diffSize.lines <= maxLines);

  const failCountLabel =
    health.failCount >= 0 ? `${health.failCount} failing` : 'fail count unknown';
  const results: GateResult[] = [
    {
      gate: 'test',
      level: effectiveLevel('test', levels.test.level, enfAblated),
      passed: health.green,
      skipped: false,
      reason: health.green
        ? 'tests green'
        : `Test gate failed (${failCountLabel}, accepted baseline ${health.baseline}) — ` +
          `run \`${resolveTestCommand(kshetra)}\` and fix the failures.`,
      durationMs: timings.healthMs ?? 0,
    },
    {
      gate: 'lint',
      level: effectiveLevel('lint', levels.lint.level, enfAblated),
      passed: lint.passed,
      skipped: lint.skipped,
      reason: lint.passed
        ? lint.skipped
          ? 'lint skipped (no command configured)'
          : 'lint clean'
        : `Lint gate failed — run \`${resolveLintCommand(kshetra)}\` and fix the reported problems.`,
      durationMs: timings.lintMs ?? 0,
    },
    {
      gate: 'coverage',
      level: effectiveLevel('coverage', levels.coverage.level, enfAblated),
      passed: coverageVerdict.passed,
      skipped: coverage.skipped,
      reason: coverageVerdict.reason,
      durationMs: coverageT.durationMs,
      ...(coverage.summary ? { coverage: coverage.summary } : {}),
    },
    {
      gate: 'diffSize',
      level: effectiveLevel('diffSize', levels.diffSize.level, enfAblated),
      passed: diffOk,
      skipped: diffSize === null,
      reason: diffOk
        ? diffSize === null
          ? 'diff size skipped (could not measure)'
          : 'diff size within limits'
        : `Diff size gate failed — ${diffSize!.files} files / ${diffSize!.lines} changed lines ` +
          `exceeds the limit (${maxFiles} files / ${maxLines} lines). Reduce the diff to the ` +
          `minimal change for this task; split unrelated work out.`,
      durationMs: diffSizeT.durationMs,
    },
  ];

  // Mark the enforcement-ablated blockers: a FAILING gate that WOULD have blocked
  // absent the ablation (its non-ablated effective level is 'block') now sits at
  // warn — tag it with the generic marker so gate_result is distinguishable from a
  // gate genuinely configured as warn (epic 8wi / Study B1).
  if (enfAblated) {
    for (const r of results) {
      if (!r.passed && !r.skipped && effectiveLevel(r.gate, levels[r.gate].level, false) === 'block') {
        r.ablations = ['enforcement'];
      }
    }
  }

  const failing = results.filter(r => !r.passed);
  const blockers = failing.filter(r => r.level === 'block');
  const warnings = failing.filter(r => r.level === 'warn');
  return { passed: blockers.length === 0, blockers, warnings, results };
}
