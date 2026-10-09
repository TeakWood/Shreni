import { sql } from 'kysely';
import type { ActorHandle } from './client';
import { loadTask, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import { InvalidRequest, MoveRefused } from './errors';
import type { Task } from './types';

// Lifecycle moves (engine spec, "Task lifecycle" and "Invariants"). A move
// locks the task row, checks the role and the guard, then makes a guarded
// UPDATE that changes the state only if it is still one the move starts from.
// The trigger refuses any undeclared change behind it.

export type MoveOptions = {
  /** Why; kept on the event. */
  reason?: string;
  /** More details for the event. */
  payload?: Record<string, unknown>;
  requestId?: string;
};

export function movesApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  const { lifecycle } = client;
  const leasedState = Object.keys(lifecycle.states).find(s => lifecycle.states[s].leased);

  /** Makes the named move on a task; throws MoveRefused. */
  return async function move(taskId: string, moveName: string, opts: MoveOptions = {}): Promise<Task> {
    const def = lifecycle.moves.find(m => m.name === moveName);
    if (!def) throw new InvalidRequest(`lifecycle ${lifecycle.name}@${lifecycle.version} has no move ${moveName}`);
    if (moveName === lifecycle.hooks.onClaim) {
      throw new InvalidRequest(`${moveName} is the claim move; take work with claim()`);
    }
    return client.transaction(async ({ db, emit }) => {
      await as.assertVersion(db);
      const task = await loadTask(db, projectId, taskId, true);
      if (!def.by.includes(as.actor.role)) throw new MoveRefused(taskId, task.state, 'NotPermitted');
      if (!def.from.includes(task.state)) throw new MoveRefused(taskId, task.state, 'WrongState');
      if (def.guard) {
        const verdict = await def.guard({ task, actor: as.actor, tx: db });
        if (verdict !== true) throw new MoveRefused(taskId, task.state, verdict);
      }

      // Any move out of the leased state ends the attempt holding it.
      const attemptId = task.state === leasedState ? task.leaseAttemptId : null;
      if (attemptId) {
        await sql`update taskgraph.attempts set ended_at = taskgraph.now(), outcome = ${moveName}
                   where id = ${attemptId} and ended_at is null`.execute(db);
      }
      const boosted = def.boost ? sql`true` : def.clearsBoost ? sql`false` : sql`boosted`;
      const terminal = !!lifecycle.states[def.to]?.terminal;
      const r = await sql<TaskRow>`
        update taskgraph.tasks
           set state = ${def.to}, boosted = ${boosted},
               lease_attempt_id = null, lease_expires_at = null,
               closed_at = ${terminal ? sql`taskgraph.now()` : sql`closed_at`},
               updated_at = taskgraph.now()
         where project_id = ${projectId} and id = ${taskId} and state = ${task.state}
        returning ${TASK_COLUMNS}`.execute(db);
      // The row is locked, so this can't miss; kept as the spec's compare-and-set.
      if (!r.rows[0]) throw new MoveRefused(taskId, task.state, 'WrongState');
      emit({
        projectId, taskId, attemptId: attemptId ?? undefined, kind: `move:${moveName}`,
        actor: as.actor.id, actorRole: as.actor.role, fromState: task.state, toState: def.to,
        requestId: opts.requestId,
        payload: { ...(opts.payload ?? {}), ...(opts.reason ? { reason: opts.reason } : {}) },
      });
      return toTask(r.rows[0]);
    });
  };
}
