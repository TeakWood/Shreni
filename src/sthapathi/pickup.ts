import { z } from 'zod';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { git } from './git.js';
import { checkBaseBranch } from './base-branch.js';
import { checkHealth, ensureHealthBead, isHealthBead } from './health.js';
import { emit } from './activity-log.js';
import { isAblated } from '../kshetra/ablation.js';
import { REPO_MAP_RELATIVE_PATH } from '../kshetra/repo-map.js';
import { loadState, pauseKshetra, recordStall, MISSING_BASE_BRANCH_REASON } from '../kshetra/state.js';
import { appendNotification } from './notifications.js';

// Re-exported for back-compat: .4 first exported this from pickup, and the
// approval CLI (.5) imports it here. The definition now lives in state.js (see
// there for why). Phalaka's read layer imports it straight from state.js.
export { MISSING_BASE_BRANCH_REASON };
// The bead type the legacy Suthradhara commit engine used for its per-session
// audit bead. That engine is gone (epic d3y — launched planning sessions file
// directly and write no audit bead), but historical `suthradhara-session` beads
// may still exist in a Kshetra's DB, so Sthapathi keeps filtering them out of
// its pickup queue rather than trying to "work" one.
const SUTHRADHARA_SESSION_TYPE = 'suthradhara-session';
// An epic is a CONTAINER, never executable work (Shreni-beads-q08); the engine
// settles it once its children finish.
const EPIC_TYPE = 'epic';

export class PreFlightError extends Error {
  constructor(
    public readonly task: Task,
    message: string,
  ) {
    super(message);
    this.name = 'PreFlightError';
  }
}

// Pause the Kshetra + notify the operator that repo.mainBranch is missing on
// origin, IDEMPOTENTLY: if it is already paused for this reason we neither
// re-pause nor re-notify, so the 30s poll cannot spam the feed. (The worker's
// selectNext gate also stops re-reaching preFlightCheck once it is manually
// paused; this guard makes the notify idempotent independently of that path.)
function pauseForMissingBaseBranch(kshetra: KshetraConfig, branch: string): void {
  const current = loadState().kshetras[kshetra.id];
  if (current?.paused === true && current.reason === MISSING_BASE_BRANCH_REASON) return;
  pauseKshetra(kshetra, {
    manual: true,
    reason: MISSING_BASE_BRANCH_REASON,
    message: `Base branch '${branch}' does not exist on origin`,
  });
  appendNotification(kshetra.id, {
    ts: new Date().toISOString(),
    event: MISSING_BASE_BRANCH_REASON,
    reason: `The configured base branch '${branch}' does not exist on origin.`,
    remediation: `Create it on origin, then resume: shreni base-branch create ${kshetra.id}`,
    message: `Kshetra '${kshetra.id}' paused — base branch '${branch}' is missing on origin.`,
  });
}

const BeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number().int().min(0).max(4),
  status: z.string(),
  description: z.string().optional(),
  notes: z.string().optional(),
  // The reads name this `issue_type`. Optional so a source that omits it still
  // parses; rankCandidates uses it to drop epics and suthradhara-session tasks.
  issue_type: z.string().optional(),
});

// Deterministic slug from a task title — the same function that names task
// branches at creation, exported so reconcile can reconstruct a task's branch
// name from its title (the task rows carry no slug field).
export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function parseReadyOutput(raw: string): Task[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tasks: Task[] = [];
  for (const item of parsed) {
    const result = BeadsIssueSchema.safeParse(item);
    if (!result.success) continue;
    const r = result.data;
    tasks.push({
      id: r.id,
      slug: toSlug(r.title),
      title: r.title,
      description: r.description,
      status: 'pending',
      priority: r.priority,
      notes: r.notes,
      type: r.issue_type,
    });
  }
  return tasks;
}

// What pickup would select from a list of task rows, best first: epics and
// suthradhara-session tasks are never work. Stable sort: P0 first, then arrival
// order (FIFO) within a priority. drain's exit classification reads it.
export function rankCandidates(tasks: Task[]): Task[] {
  return tasks
    .filter(t => t.type !== SUTHRADHARA_SESSION_TYPE && t.type !== EPIC_TYPE)
    .sort((a, b) => a.priority - b.priority);
}

export async function preFlightCheck(task: Task, kshetra: KshetraConfig): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;

  // Base-branch guard (uvu.4): the whole loop branches from and pushes to
  // origin/<mainBranch>. When it is missing on origin — a custom or mistyped
  // value that was never pushed — the checkout(main) + pull below fail
  // cryptically on EVERY poll. Detect it up front, pause the Kshetra for
  // operator approval (idempotent — one notification, not one per poll), and
  // abort the cycle cleanly via PreFlightError (the claim is given back).
  const { exists } = await checkBaseBranch(kshetra, g);
  if (!exists) {
    pauseForMissingBaseBranch(kshetra, main);
    throw new PreFlightError(task, `base branch '${main}' missing on origin`);
  }

  await g.checkout(main);

  // The repo map (.shreni/repo-map.md) is a deterministic, regenerated-on-merge
  // cache, not source. squashMergeAndClose regenerates it fire-and-forget AFTER
  // the merge commit, so it lands in the working tree uncommitted; if the repo
  // tracks it (a map committed before it was gitignored), that lone change trips
  // the cleanliness gate below and wedges the worker on EVERY poll — preflight
  // returns null forever and no bead ever starts. It is a derived artifact, never
  // real drift, and a git op (checkout/merge) would also refuse a dirty tracked
  // file, so discard its working-tree churn here before the gate. Untracked
  // (gitignored) maps aren't reported by status anyway — this is the belt for
  // repos that still track it. See src/kshetra/repo-map.ts.
  await g.discardPath(REPO_MAP_RELATIVE_PATH);

  const status = await g.status();
  const dirty = [...status.modified, ...status.staged];
  if (dirty.length > 0) {
    throw new PreFlightError(task, `dirty working tree: ${dirty.join(', ')}`);
  }

  await g.pull('--rebase', 'origin', main);

  const branch = `bead-${task.id}/${task.slug}`;
  if (await g.branchExists(branch)) {
    throw new PreFlightError(task, `branch already exists: ${branch}`);
  }
}

// The health gate: true when the task may
// start. On a red base it queues the repair task, records the stall and
// returns false, unless enforcement is ablated.
export async function healthGate(task: Task, kshetra: KshetraConfig): Promise<boolean> {
  // Health gate: a fresh feature task only starts when the base suite is green
  // (modulo the accepted baseline). preFlightCheck has put us on a clean, pulled
  // main, so this measures the right tree. A red base does not start the task —
  // it queues a P0 repair bead instead, which is exempt from this gate. This
  // runs at the prepare boundary only, never mid-loop, so it can't interfere with
  // an in-flight Silpi↔Viharapala round.
  if (isHealthBead(task)) return true;
  const health = await checkHealth(kshetra);
  if (!health.green) {
    // Enforcement ablation (epic 8wi / Study B1): the pickup health gate is a
    // blocking point — under the ablation it does NOT defer and does NOT create a
    // repair bead; it claims on a red suite. Record the suppression (decision-
    // grade) so the ledger shows work was claimed on a red base — a gate_result
    // for the synthetic 'pickup-health' gate at warn with the enforcement marker
    // (round 0 = pre-round / pickup boundary).
    if (isAblated(kshetra, 'enforcement')) {
      emit({
        type: 'gate_result', kshetra: kshetra.id, beadId: task.id, round: 0,
        gate: 'pickup-health', verdict: 'warn', ablations: ['enforcement'],
      });
      console.warn(
        `[shreni prepare:${kshetra.id}] base suite red ` +
          `(${health.failCount} failing > baseline ${health.baseline}); ` +
          `enforcement ablated — claiming ${task.id} on a red base (no repair bead)`,
      );
    } else {
      const created = await ensureHealthBead(kshetra, health.failCount);
      recordStall(kshetra, 'base suite red');
      console.warn(
        `[shreni prepare:${kshetra.id}] base suite red ` +
          `(${health.failCount} failing > baseline ${health.baseline}); ` +
          `deferring ${task.id}, ${created ? 'queued' : 'awaiting'} health repair`,
      );
      return false;
    }
  }
  return true;
}

/** Preflight refused a fresh task because the base suite is red (the repair task is queued). */
export class BaseRedError extends PreFlightError {
  constructor(task: Task) {
    super(task, 'base suite red; deferring for the health repair');
    this.name = 'BaseRedError';
  }
}

// The engine's preflight for a fresh task: the work tree, then the health gate.
export async function preFlightFresh(task: Task, kshetra: KshetraConfig): Promise<void> {
  await preFlightCheck(task, kshetra);
  if (!(await healthGate(task, kshetra))) throw new BaseRedError(task);
}
