import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { git } from './git.js';
import { bd } from './beads.js';
import { getHealthBaseline } from '../kshetra/state.js';
import { resolveTestCommand, splitCommand } from '../kshetra/toolchain.js';

const execFileAsync = promisify(execFile);

// Beads with a title beginning with this marker are "restore the suite" repair
// tasks. They are EXEMPT from the green-suite precondition (they are the thing
// that makes it green) and are gated on "failures must decrease" instead.
export const HEALTH_BEAD_PREFIX = '[shreni-health]';
export const HEALTH_BEAD_TITLE = `${HEALTH_BEAD_PREFIX} Restore green test suite`;

export interface TestRunResult {
  passed: boolean;
  // Best-effort count of failing tests parsed from runner output. -1 when the
  // suite is red but the count could not be parsed (still treated as "not green").
  failCount: number;
  raw: string;
}

export interface HealthStatus {
  green: boolean;
  failCount: number;
  baseline: number;
  sha: string;
}

// Parse a failing-test count from common runner summaries, best-effort across
// ecosystems. The exit code is the primary pass/fail signal (see runTestSuite);
// this count only refines the "within baseline" comparison. The generic
// `N failed` pattern covers vitest/jest/pytest/cargo; an optional
// stack.failCountPattern override wins for a non-standard summary.
//   vitest: "Tests  2 failed | 30 passed (32)"
//   jest:   "Tests:       2 failed, 30 passed, 32 total"
//   pytest: "=== 2 failed, 30 passed in 1.2s ==="
//   cargo:  "test result: FAILED. 30 passed; 2 failed;"
// Returns -1 when no count can be found (a red suite with an unknown count is
// still treated as "not green").
export function parseFailCount(raw: string, pattern?: string): number {
  const patterns: RegExp[] = [];
  if (pattern) {
    try {
      patterns.push(new RegExp(pattern, 'i'));
    } catch {
      // A malformed override falls through to the built-in patterns.
    }
  }
  patterns.push(/Tests:?\s+(\d+)\s+failed/i, /(\d+)\s+failed/i);
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1] !== undefined) return Number(m[1]);
  }
  return -1;
}

// Run the full configured test suite in the Kshetra repo. Resolves (never
// rejects) with the exit-code-derived pass/fail and a best-effort fail count.
// An empty test command means the Kshetra has no test gate — that is a visible,
// logged decision (not a silent pass), reported as green with a note.
export async function runTestSuite(kshetra: KshetraConfig): Promise<TestRunResult> {
  const [cmd, ...args] = splitCommand(resolveTestCommand(kshetra));
  if (!cmd) {
    console.warn(`[health] ${kshetra.id}: no test command configured — test gate skipped`);
    return { passed: true, failCount: 0, raw: '(no test command configured — test gate skipped)' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: kshetra.repo.path,
      maxBuffer: 32 * 1024 * 1024,
    });
    const raw = stdout + stderr;
    return { passed: true, failCount: 0, raw };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
    return { passed: false, failCount: parseFailCount(raw, kshetra.stack.failCountPattern), raw };
  }
}

// sha-keyed cache so we don't re-run the suite on every 30s poll. main only
// moves through squashMergeAndClose, so a stable HEAD means a stable verdict.
const cache = new Map<string, { sha: string; status: HealthStatus }>();

export function invalidateHealth(kshetra: KshetraConfig): void {
  cache.delete(kshetra.repo.path);
}

function computeStatus(result: TestRunResult, baseline: number, sha: string): HealthStatus {
  // "green enough" = no failures beyond the accepted baseline. An unknown count
  // (-1) on a red suite is never green.
  const green = result.passed || (result.failCount >= 0 && result.failCount <= baseline);
  const failCount = result.passed ? 0 : result.failCount;
  return { green, failCount, baseline, sha };
}

// Check whether the current tree's base (HEAD) is green, modulo the accepted
// baseline of known-failing tests. Cached by HEAD sha.
export async function checkHealth(kshetra: KshetraConfig): Promise<HealthStatus> {
  const sha = await git(kshetra).headSha();
  const baseline = getHealthBaseline(kshetra);
  const cached = cache.get(kshetra.repo.path);
  if (cached && cached.sha === sha && cached.status.baseline === baseline) {
    return cached.status;
  }
  const result = await runTestSuite(kshetra);
  const status = computeStatus(result, baseline, sha);
  cache.set(kshetra.repo.path, { sha, status });
  return status;
}

// Like checkHealth but always re-runs — used after Silpi mutates the tree
// during a repair loop, where the verdict must reflect the new code.
export async function measureHealth(kshetra: KshetraConfig): Promise<HealthStatus> {
  const sha = await git(kshetra).headSha();
  const baseline = getHealthBaseline(kshetra);
  const result = await runTestSuite(kshetra);
  const status = computeStatus(result, baseline, sha);
  cache.set(kshetra.repo.path, { sha, status });
  return status;
}

export function isHealthBead(task: Task): boolean {
  return task.title.startsWith(HEALTH_BEAD_PREFIX);
}

// Ensure a single open repair bead exists. Returns true if one was created.
// Idempotent: if a health bead is already open/ready, does nothing.
export async function ensureHealthBead(
  kshetra: KshetraConfig,
  failCount: number,
): Promise<boolean> {
  const bdClient = bd(kshetra);
  for (const status of ['open', 'in_progress', 'blocked']) {
    const raw = await bdClient.list({ status });
    if (rawHasHealthBead(raw)) return false;
  }
  const countLabel = failCount >= 0 ? `${failCount}` : 'an unknown number of';
  await bdClient.create(
    `${HEALTH_BEAD_TITLE} (${countLabel} failing)`,
    0,
    'bug',
  );
  return true;
}

function rawHasHealthBead(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some(
    item =>
      typeof (item as { title?: unknown }).title === 'string' &&
      (item as { title: string }).title.startsWith(HEALTH_BEAD_PREFIX),
  );
}
