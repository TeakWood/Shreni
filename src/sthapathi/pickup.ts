import { z } from 'zod';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';
import { checkBaseBranch } from './base-branch.js';
import { checkHealth, ensureHealthBead, isHealthBead } from './health.js';
import { emit } from './activity-log.js';
import { isAblated } from '../kshetra/ablation.js';
import { REPO_MAP_RELATIVE_PATH } from '../kshetra/repo-map.js';
import { loadState, pauseKshetra, recordProgress, recordStall, MISSING_BASE_BRANCH_REASON } from '../kshetra/state.js';
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
  // bd names this `issue_type` in --json output. Optional so a source that omits
  // it still parses; pickNext uses it to drop suthradhara-session beads (§9.1).
  issue_type: z.string().optional(),
});

// Deterministic slug from a bead title — the same function that names bead
// branches at creation, exported so reconcilePullRequests can reconstruct a
// bead's branch name from its title (bd list --json carries no slug field).
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

// Stable sort: P0 first, then preserve arrival order (FIFO) within same priority.
//
// QUEUE ISOLATION (ARD §9.1): a `suthradhara-session` bead is Suthradhara's own
// tracking spine — never executable work — so it must never be handed to a
// Silpi. Its type is set at the bead's creation, so this filter excludes it from
// the very first instant, even during the sub-second window before the server
// marks it in_progress (the structural half of isolation, which keeps it out of
// the unclaimed `bd ready` pool). Filtering HERE, in pickNext, is the load-
// bearing, race-proof guarantee and is asserted directly by test. This is the
// single Suthradhara-driven touch to Sthapathi — a selection-path line, not a
// state-machine change (§13.1).
export function pickNext(tasks: Task[]): Task | null {
  const eligible = tasks.filter(t => t.type !== SUTHRADHARA_SESSION_TYPE);
  if (eligible.length === 0) return null;
  const sorted = eligible.slice().sort((a, b) => a.priority - b.priority);
  return sorted[0] ?? null;
}

export async function preFlightCheck(task: Task, kshetra: KshetraConfig): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;

  // Base-branch guard (uvu.4): the whole loop branches from and pushes to
  // origin/<mainBranch>. When it is missing on origin — a custom or mistyped
  // value that was never pushed — the checkout(main) + pull below fail
  // cryptically on EVERY poll. Detect it up front, pause the Kshetra for
  // operator approval (idempotent — one notification, not one per poll), and
  // abort the cycle cleanly via PreFlightError (prepareTask returns null).
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

// SELECT (read-only). Picks the highest-priority ready bead. Performs NO git ops
// and NO claim, so it is safe to call on every poll — the scheduler only commits
// to mutating the work tree once it advances a selected task into PREPARE. This
// separation is what stops a poll from checking out main under an in-flight agent
// (see the Sthapathi workflow design §4.2).
export async function selectNext(kshetra: KshetraConfig): Promise<Task | null> {
  const raw = await bd(kshetra).ready();
  return pickNext(parseReadyOutput(raw));
}

// PREPARE (the ONLY mutator in the pickup path) + bd claim. Syncs beads, runs
// preFlightCheck (checkout main, pull, branch guard) and the health gate, then
// claims. Returns the task when it is ready to work, or null when preflight
// rejects or the base suite is red — both logged, so a wedge is never silent.
export async function prepareTask(task: Task, kshetra: KshetraConfig): Promise<Task | null> {
  if (task.followup) return prepareFollowup(task, kshetra);
  await syncBeads(kshetra);
  try {
    await preFlightCheck(task, kshetra);
  } catch (err) {
    if (err instanceof PreFlightError) {
      // Surface the rejection — otherwise a leftover branch or persistently
      // dirty tree wedges the worker silently, returning null on every poll
      // with no clue why nothing is progressing. Record the stall so the
      // watchdog trips if the same rejection repeats.
      recordStall(kshetra, `preflight: ${err.message}`);
      console.warn(`[shreni prepare:${kshetra.id}] preflight rejected ${task.id}: ${err.message}`);
      return null;
    }
    throw err;
  }

  // Health gate: a fresh feature task only starts when the base suite is green
  // (modulo the accepted baseline). preFlightCheck has put us on a clean, pulled
  // main, so this measures the right tree. A red base does not start the task —
  // it queues a P0 repair bead instead, which is exempt from this gate. This
  // runs at the prepare boundary only, never mid-loop, so it can't interfere with
  // an in-flight Silpi↔Viharapala round.
  if (!isHealthBead(task)) {
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
        return null;
      }
    }
  }

  await bd(kshetra).claim(task.id);
  // Forward progress: a bead was successfully claimed — clear any stall counter.
  recordProgress(kshetra);
  return task;
}

// PREPARE for a PR follow-up bead (epic hjw). Unlike a fresh task this bead is
// already in_progress + awaiting-merge with an existing branch and open PR, so
// there is NO claim, NO fresh-work preFlightCheck (which branches from main and
// rejects an existing branch), and NO health gate (a pickup-only precondition for
// admitting NEW work). Instead: sync beads, then adopt the PR head — fetch
// origin/<branch> and hard-reset the local branch to it. The reset makes any
// commits a collaborator pushed the new base (the "foreign commit" trigger
// becomes a re-sync, ARD §4.2) and guarantees the fix builds on the real PR head,
// even if RECOVER dropped the stale local branch (checkout DWIMs it from origin).
async function prepareFollowup(task: Task, kshetra: KshetraConfig): Promise<Task | null> {
  await syncBeads(kshetra);
  const g = git(kshetra);
  const branch = `bead-${task.id}/${task.slug}`;
  try {
    await g.fetch('origin', branch);
    await g.checkout(branch);
    await g.resetHard(`origin/${branch}`);
  } catch (err) {
    // The branch/PR is gone or unreachable — cannot follow up this cycle. Record
    // the stall (so a persistent failure trips the watchdog) and idle; the next
    // reconcile re-evaluates the PR's terminal state.
    recordStall(kshetra, `pr-followup prepare: ${(err as Error).message}`);
    console.warn(`[shreni prepare:${kshetra.id}] pr-followup prepare failed for ${task.id}: ${(err as Error).message}`);
    return null;
  }
  recordProgress(kshetra);
  return task;
}