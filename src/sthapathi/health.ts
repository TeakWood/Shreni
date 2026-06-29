import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { git } from './git.js';
import { bd } from './beads.js';
import { getHealthBaseline } from '../kshetra/state.js';

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

// Parse a failing-test count from common runner summaries (vitest, jest).
//   vitest: "Tests  2 failed | 30 passed (32)"
//   jest:   "Tests:       2 failed, 30 passed, 32 total"
// Returns -1 when no count can be found.
export function parseFailCount(raw: string): number {
  const patterns = [
    /Tests:?\s+(\d+)\s+failed/i,
    /(\d+)\s+failed/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return Number(m[1]);
  }
  return -1;
}

function testCommand(kshetra: KshetraConfig): string[] {
  const runner = kshetra.stack.testRunner?.trim() || 'pnpm test';
  return runner.split(/\s+/);
}

// Run the full configured test suite in the Kshetra repo. Resolves (never
// rejects) with the exit-code-derived pass/fail and a best-effort fail count.
export async function runTestSuite(kshetra: KshetraConfig): Promise<TestRunResult> {
  const [cmd, ...args] = testCommand(kshetra);
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
    return { passed: false, failCount: parseFailCount(raw), raw };
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
