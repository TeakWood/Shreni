import { sql, type Kysely } from 'kysely';
import type { Lifecycle } from './lifecycle';
import { loadTask, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import { claimableState } from './ready';
import { textArray } from './sql-values';
import { InvalidRequest } from './errors';
import type { Task } from './types';

// Containers and dependents (engine spec, "Containers" and "Cancelled work
// doesn't strand its dependents"). A container holds its subtree (the ready
// predicate), never closes over live children, and its settled check runs
// under its own row lock, which every child creation or terminal move takes
// first.

export const terminalStates = (lifecycle: Lifecycle) =>
  Object.keys(lifecycle.states).filter(s => lifecycle.states[s].terminal);

export const isTerminal = (lifecycle: Lifecycle, state: string) => !!lifecycle.states[state]?.terminal;

/**
 * Locks a task's parent row, then the task's, in that order, as tasks.update
 * does; starts over if the task moves to another parent in between.
 */
export async function lockWithParent(db: Kysely<any>, projectId: string, id: string): Promise<Task> {
  for (let tries = 0; tries < 3; tries++) {
    const seen = await loadTask(db, projectId, id);
    if (seen.parentId) await loadTask(db, projectId, seen.parentId, true);
    const locked = await loadTask(db, projectId, id, true);
    if (locked.parentId === seen.parentId) return locked;
  }
  throw new InvalidRequest(`task ${id} kept moving while being changed; try again`);
}

/** A child may sit only under a parent that hasn't closed. */
export function assertParentOpen(lifecycle: Lifecycle, parent: Task, child: string): void {
  if (isTerminal(lifecycle, parent.state)) {
    throw new InvalidRequest(`task ${parent.id} is ${parent.state}; ${child} can't be put under it`);
  }
}

/** The ids of a task's children that aren't terminal. */
export async function liveChildren(db: Kysely<any>, projectId: string, id: string, lifecycle: Lifecycle): Promise<string[]> {
  const r = await sql<{ id: string }>`
    select id from taskgraph.tasks
     where project_id = ${projectId} and parent_id = ${id} and state <> all (${textArray(terminalStates(lifecycle))})
     order by id`.execute(db);
  return r.rows.map(x => x.id);
}

/** The ids of non-terminal tasks that depend on a task. */
export async function liveDependents(db: Kysely<any>, projectId: string, id: string, lifecycle: Lifecycle): Promise<string[]> {
  const r = await sql<{ id: string }>`
    select t.id from taskgraph.task_deps d
      join taskgraph.tasks t on t.project_id = d.project_id and t.id = d.task_id
     where d.project_id = ${projectId} and d.depends_on_id = ${id}
       and t.state <> all (${textArray(terminalStates(lifecycle))})
     order by t.id`.execute(db);
  return r.rows.map(x => x.id);
}

/**
 * True when the task is a container with children, all of them terminal.
 * Callers hold its row lock, so they see every sibling's latest state, and
 * write children.settled when a change of theirs turns this true.
 */
export async function containerSettled(db: Kysely<any>, projectId: string, id: string, lifecycle: Lifecycle): Promise<boolean> {
  const r = await sql<{ settled: boolean }>`
    select exists (select 1 from taskgraph.tasks where project_id = ${projectId} and id = ${id} and kind = 'container')
       and exists (select 1 from taskgraph.tasks where project_id = ${projectId} and parent_id = ${id})
       and not exists (select 1 from taskgraph.tasks where project_id = ${projectId} and parent_id = ${id}
                          and state <> all (${textArray(terminalStates(lifecycle))})) as settled`.execute(db);
  return r.rows[0].settled;
}

/**
 * Containers in the claimable state whose children have all settled, oldest
 * first: the ones a caller completes, if it missed children.settled.
 */
export async function settledContainers(db: Kysely<any>, projectId: string, lifecycle: Lifecycle): Promise<Task[]> {
  const terminal = textArray(terminalStates(lifecycle));
  const r = await sql<TaskRow>`
    select ${TASK_COLUMNS} from taskgraph.tasks t
     where t.project_id = ${projectId} and t.kind = 'container' and t.state = ${claimableState(lifecycle)}
       and exists (select 1 from taskgraph.tasks c where c.project_id = t.project_id and c.parent_id = t.id)
       and not exists (select 1 from taskgraph.tasks c where c.project_id = t.project_id and c.parent_id = t.id
                          and c.state <> all (${terminal}))
     order by t.created_at, t.id`.execute(db);
  return r.rows.map(toTask);
}
