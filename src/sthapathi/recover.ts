import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';
import { branchName } from './branch.js';
import { recordBeadAttempt, recordProgress } from '../kshetra/state.js';

// Signature of the work loop a resume re-enters. Matches
// runSilpiViharapalaLoop / runHealthRepairLoop so either can be injected.
export type ResumeRunner = (
  kshetra: KshetraConfig,
  task: Task,
  branch: string,
) => Promise<{ approved: boolean; note: string }>;

// A bead is reopened after a crash/restart at most this many times before it is
// left blocked for a human. Prevents the reopen→fail→reopen loop. Default per
// the Sthapathi workflow design §4.5 (D1); made configurable later (bjo).
export const MAX_RECOVER_ATTEMPTS = 3;

export function parseInFlightTasks(raw: string): Task[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tasks: Task[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (typeof item.id !== 'string' || typeof item.title !== 'string') continue;
    tasks.push({
      id: item.id,
      slug: String(item.slug ?? item.id),
      title: item.title,
      status: 'in_progress',
      priority: typeof item.priority === 'number' ? item.priority : 2,
      round: typeof item.round === 'number' ? item.round : 1,
      notes: typeof item.notes === 'string' ? item.notes : undefined,
    });
  }
  return tasks;
}

// RECOVER — reconcile the four drifting truths (work tree, git branches, bead
// status, scheduler phase) back to a clean IDLE after a crash, restart, or a
// PREPARE that detected drift. We do NOT try to resume a half-done bead from the
// exact stage it died at (fragile); instead we discard the interrupted work and
// reopen the bead for a fresh cycle, under an attempt budget. This codifies the
// manual recovery captured in `bd remember [shreni-worker-recovery]`.
// See the Sthapathi workflow design §4.3.
export async function recoverKshetra(
  kshetra: KshetraConfig,
  opts: { keepBranch?: string } = {},
): Promise<Task[]> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;

  // 1. Reset the work tree to a clean main — discard any interrupted, uncommitted
  //    work so the next PREPARE starts from a sanctioned point.
  await g.resetHard();
  await g.checkout(main);
  await g.clean();

  // 2. Drop stale bead-* branches. Nothing is active at startup; when invoked
  //    mid-run from PREPARE, opts.keepBranch protects the in-flight bead's branch.
  //    A leftover branch makes preFlightCheck reject its bead forever
  //    ("branch already exists").
  for (const branch of await g.branches('bead-')) {
    if (branch === opts.keepBranch) continue;
    await g.deleteBranch(branch, { force: true });
  }

  // 3. Reopen beads stranded in_progress by the interruption — under the attempt
  //    budget. Past MAX_RECOVER_ATTEMPTS, leave the bead blocked and escalate to
  //    a human rather than loop on it.
  const maxAttempts = kshetra.watchdog?.maxRecoverAttempts ?? MAX_RECOVER_ATTEMPTS;
  // Exclude awaiting-merge beads (mergePolicy 'pr', 3r2): they are intentionally
  // left in_progress with their branch/PR open, NOT stranded by a crash. Reopening
  // and re-working one would discard an already-approved change that is just
  // waiting on a human merge. reconcilePullRequests closes them when the PR lands.
  const inFlight = parseInFlightTasks(
    await bd(kshetra).list({ status: 'in_progress', excludeLabel: 'awaiting-merge' }),
  );
  const resumable: Task[] = [];
  for (const task of inFlight) {
    const attempts = recordBeadAttempt(kshetra, task.id);
    if (attempts > maxAttempts) {
      await bd(kshetra).flag(
        task.id,
        `Recover: exceeded ${maxAttempts} restart attempts — left blocked for human review.`,
      );
    } else {
      await bd(kshetra).reopen(task.id);
      await bd(kshetra).addNote(
        task.id,
        `Recovered after restart (attempt ${attempts}/${maxAttempts}) — reopened for a fresh cycle.`,
      );
      resumable.push(task);
    }
  }

  await syncBeads(kshetra);

  // Hand the reopened beads back to the caller (the worker) so it can RESUME
  // them via the work loop — bypassing the pickup health gate — instead of
  // waiting for the next gated poll to re-select them. See scheduleResume.
  return resumable;
}

// RESUME — re-enter the WORK phase for a bead that was already in flight, without
// going back through SELECT / PREPARE. Used for a bead reopened by RECOVER after a
// crash/restart (and, in future, the mid-loop merge-conflict re-dispatch).
//
// Resume deliberately does NOT run the pickup health gate (checkHealth). That gate
// is a pickup-only precondition that admits *new* feature work only onto a green
// base; it runs at the prepare boundary, never mid-loop. A bead that is already in
// flight was admitted when it was first picked up, so re-gating it on resume would
// (a) re-run the whole suite inside the work loop — exactly the mid-loop suite run
// the phase machine forbids (the jhl regression), and (b) let a base that went red
// *after* admission strand an otherwise-in-progress bead. runSilpiViharapalaLoop
// routes [shreni-health] beads to the repair loop internally, so this single
// entrypoint resumes both feature and repair work. See the Sthapathi workflow
// design §4.2: WIP resumes via the recovery path, bypassing the gate.
export async function scheduleResume(
  kshetra: KshetraConfig,
  task: Task,
  run?: ResumeRunner,
): Promise<{ approved: boolean; note: string }> {
  // Re-claim the reopened bead (RECOVER set it back to open). This is the only
  // pickup-side step resume performs — no preFlightCheck, no checkHealth.
  await bd(kshetra).claim(task.id);
  recordProgress(kshetra);
  // Lazy-load the loop so recover.ts's static import graph (and its unit tests)
  // never pull in the agent modules; production callers inject the runner.
  const runTask = run ?? (await import('./dispatch.js')).runSilpiViharapalaLoop;
  return runTask(kshetra, task, branchName(task));
}
