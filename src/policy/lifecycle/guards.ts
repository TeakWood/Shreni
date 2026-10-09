import { sql } from 'kysely';
import { defineGuard, type GuardFn } from '../../taskgraph';

// Shreni's three guards (policy spec, "The lifecycle"). Each reads only the
// database, in the move's transaction, and returns true or why it refuses.
//
// Keep each function self-contained, with no helpers: the snapshot test
// hashes these sources, so a guard made stricter without a lifecycle
// version bump fails review (policy spec, "Lifecycle upgrades in practice").

/** submit: the attempt's evidence records a PR. Sthapathi writes it first, since a guard can't call GitHub. */
const hasOpenPrFn: GuardFn = async ({ task, tx }) => {
  if (!task.leaseAttemptId) return 'the task holds no attempt to submit';
  const r = await sql<{ pr_url: string | null }>`
    select pr_url from shreni.attempt_evidence where attempt_id = ${task.leaseAttemptId}`.execute(tx);
  return r.rows[0]?.pr_url ? true : 'the attempt has no open PR recorded';
};

/**
 * finish: the task's locked acceptance checks passed on its latest attempt. A
 * task with no checks, imported or filed by hand, is grandfathered: it
 * finishes on review and gates, or on the developer's word.
 */
const checksPassedFn: GuardFn = async ({ task, tx }) => {
  const checks = await sql<{ n: number }>`
    select count(*)::int as n from shreni.acceptance_checks
     where project_id = ${task.projectId} and task_id = ${task.id}`.execute(tx);
  if (checks.rows[0].n === 0) return true;
  // The current attempt: the lease's when claimed, else the newest. Its
  // evidence decides; an attempt with none hasn't passed.
  const evidence = await sql<{ passed: boolean }>`
    select coalesce(e.gates -> 'acceptance' -> 'passed' = 'true'::jsonb, false) as passed
      from taskgraph.attempts a left join shreni.attempt_evidence e on e.attempt_id = a.id
     where a.project_id = ${task.projectId} and a.task_id = ${task.id}
     order by (a.id = ${task.leaseAttemptId}::uuid) desc nulls last, a.started_at desc, a.id desc
     limit 1`.execute(tx);
  return evidence.rows[0]?.passed === true ? true : 'the task\'s acceptance checks haven\'t passed';
};

/**
 * confirm: the developer's confirmation finishes only a task whose work
 * landed on main and whose manual checks were what held it: the newest
 * attempt records both that it landed and that its acceptance passed, and
 * the task has a manual check.
 */
const checksConfirmedFn: GuardFn = async ({ task, tx }) => {
  const manual = await sql<{ n: number }>`
    select count(*)::int as n from shreni.acceptance_checks
     where project_id = ${task.projectId} and task_id = ${task.id} and mode = 'manual'`.execute(tx);
  if (manual.rows[0].n === 0) return 'the task has no manual check to confirm';
  const evidence = await sql<{ landed: boolean; passed: boolean }>`
    select coalesce(e.gates -> 'landed' = 'true'::jsonb, false) as landed,
           coalesce(e.gates -> 'acceptance' -> 'passed' = 'true'::jsonb, false) as passed
      from taskgraph.attempts a left join shreni.attempt_evidence e on e.attempt_id = a.id
     where a.project_id = ${task.projectId} and a.task_id = ${task.id}
     order by (a.id = ${task.leaseAttemptId}::uuid) desc nulls last, a.started_at desc, a.id desc
     limit 1`.execute(tx);
  const row = evidence.rows[0];
  if (!row?.landed) return 'the task\'s work never landed on main';
  return row.passed ? true : 'the task\'s acceptance checks haven\'t passed';
};

/** completeContainer: a container whose children are all terminal, with at least one done. */
const childrenSettledFn: GuardFn = async ({ task, tx }) => {
  if (task.kind !== 'container') return 'only a container is completed; finish a work task';
  // Terminal and done (satisfiesDeps) states from the project's active lifecycle, not by name.
  const r = await sql<{ live: number; done: number }>`
    with flags as (
      select s.key as state, s.value ? 'terminal' as terminal, s.value ? 'satisfiesDeps' as done
        from taskgraph.projects p
        join taskgraph.lifecycles l on l.name = p.lifecycle_name and l.version = p.lifecycle_version
        cross join jsonb_each(l.definition -> 'states') s
       where p.id = ${task.projectId}
    )
    select count(*) filter (where not coalesce(f.terminal, false))::int as live,
           count(*) filter (where coalesce(f.done, false))::int as done
      from taskgraph.tasks t left join flags f on f.state = t.state
     where t.project_id = ${task.projectId} and t.parent_id = ${task.id}`.execute(tx);
  if (r.rows[0].live > 0) return 'the container has children that aren\'t finished';
  if (r.rows[0].done === 0) return 'no child is done: cancel the container, or file work under it';
  return true;
};

/** The guards' own functions, by name: the guards below are made from these, and the snapshot hashes them. */
export const GUARD_SOURCES = {
  hasOpenPr: hasOpenPrFn,
  checksPassed: checksPassedFn,
  checksConfirmed: checksConfirmedFn,
  childrenSettled: childrenSettledFn,
} as const satisfies Record<string, GuardFn>;

export const hasOpenPr = defineGuard('hasOpenPr', GUARD_SOURCES.hasOpenPr);
export const checksPassed = defineGuard('checksPassed', GUARD_SOURCES.checksPassed);
export const childrenSettled = defineGuard('childrenSettled', GUARD_SOURCES.childrenSettled);
export const checksConfirmed = defineGuard('checksConfirmed', GUARD_SOURCES.checksConfirmed);
