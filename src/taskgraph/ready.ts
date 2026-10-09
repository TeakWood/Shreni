import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Lifecycle } from './lifecycle';
import { TASK_COLUMNS, toTask, type TaskRow } from './tasks';
import { textArray } from './sql-values';
import type { Task } from './types';

// The ready predicate (engine spec, "Claiming and leases"): what a claim may
// pick. Shared by ready() and, later, the claim query, so the two can't drift.

/** The lifecycle's states that satisfy a dependency. */
export const satisfyingStates = (lifecycle: Lifecycle) =>
  Object.keys(lifecycle.states).filter(s => lifecycle.states[s].satisfiesDeps);

export const claimableState = (lifecycle: Lifecycle) =>
  Object.keys(lifecycle.states).find(s => lifecycle.states[s].claimable)!;

/**
 * True for a ready task `t`: claimable state, kind work, not held, every
 * dependency satisfied, and every container above it in the claimable state.
 */
export function readyWhere(lifecycle: Lifecycle): RawBuilder<boolean> {
  const claimable = claimableState(lifecycle);
  return sql<boolean>`(
    t.state = ${claimable}
    and t.kind = 'work'
    and (t.hold_until is null or t.hold_until <= taskgraph.now())
    and not exists (
      select 1
        from taskgraph.task_deps d
        join taskgraph.tasks dep on dep.project_id = d.project_id and dep.id = d.depends_on_id
       where d.project_id = t.project_id and d.task_id = t.id
         and dep.state <> all (${textArray(satisfyingStates(lifecycle))}))
    and not exists (
      with recursive up as (
        select p.id, p.parent_id, p.state
          from taskgraph.tasks p
         where p.project_id = t.project_id and p.id = t.parent_id
        union all
        select p.id, p.parent_id, p.state
          from taskgraph.tasks p join up on p.id = up.parent_id
         where p.project_id = t.project_id
      )
      select 1 from up where up.state <> ${claimable}))`;
}

/** Claim order: boosted first, then priority, then age. */
export const CLAIM_ORDER = sql`t.boosted desc, t.priority, t.created_at, t.id`;

export async function readyTasks(
  db: Kysely<any>, projectId: string, lifecycle: Lifecycle, opts: { limit?: number } = {},
): Promise<Task[]> {
  const r = await sql<TaskRow>`
    select ${TASK_COLUMNS} from taskgraph.tasks t
     where t.project_id = ${projectId} and ${readyWhere(lifecycle)}
     order by ${CLAIM_ORDER}
     ${opts.limit !== undefined ? sql`limit ${opts.limit}` : sql``}`.execute(db);
  return r.rows.map(toTask);
}
