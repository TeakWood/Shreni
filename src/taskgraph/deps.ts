import { sql } from 'kysely';
import type { ActorHandle } from './client';
import { loadTask, lockGraph, type WriteOptions } from './tasks';
import { CycleError, InvalidRequest, NotFound } from './errors';

// Edges between tasks (engine spec, "Invariants: the cycle check"):
// dependencies, which block, and links, which don't; plus notes. Edge writes
// in a project take one advisory lock first, so two concurrent writes can't
// each pass the cycle check and together close a cycle.

export function depsApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;

  return {
    /** taskId waits for dependsOnId; throws CycleError if dependsOnId already waits on taskId. */
    async add(taskId: string, dependsOnId: string, opts: WriteOptions = {}): Promise<void> {
      await client.transaction(async ({ db, emit }) => {
        await lockGraph(db, projectId);
        // Lock the waiting task, so its state can't change between the check and the write.
        const task = await loadTask(db, projectId, taskId, true);
        const target = await loadTask(db, projectId, dependsOnId);
        await as.check('deps.add', task.state, db);
        // Under the graph lock, which a cancel also takes: nothing waits on cancelled work.
        const { states } = client.lifecycle;
        if (states[target.state]?.terminal && !states[target.state].satisfiesDeps) {
          throw new InvalidRequest(`task ${dependsOnId} is ${target.state} and will never satisfy a dependency`);
        }
        if (taskId === dependsOnId) throw new CycleError(taskId, dependsOnId);
        const reach = await sql<{ creates_cycle: boolean }>`
          with recursive reach(id) as (
            select ${dependsOnId}::text
            union
            select d.depends_on_id from taskgraph.task_deps d join reach r on d.task_id = r.id
             where d.project_id = ${projectId}
          )
          select exists (select 1 from reach where id = ${taskId}) as creates_cycle`.execute(db);
        if (reach.rows[0].creates_cycle) throw new CycleError(taskId, dependsOnId);
        // A container finishes only once its children settle, so a dependency
        // between a task and its own ancestor can never be satisfied either.
        const nested = await sql<{ hit: boolean }>`
          with recursive up(id, parent_id, start) as (
            select id, parent_id, id from taskgraph.tasks
             where project_id = ${projectId} and id in (${taskId}, ${dependsOnId})
            union
            select t.id, t.parent_id, up.start from taskgraph.tasks t join up on t.id = up.parent_id
             where t.project_id = ${projectId}
          )
          select exists (
            select 1 from up where (start = ${taskId} and id = ${dependsOnId}) or (start = ${dependsOnId} and id = ${taskId})
          ) as hit`.execute(db);
        if (nested.rows[0].hit) throw new CycleError(taskId, dependsOnId, 'one contains the other, and a container settles only after its children');
        const added = await sql`
          insert into taskgraph.task_deps (project_id, task_id, depends_on_id) values (${projectId}, ${taskId}, ${dependsOnId})
          on conflict do nothing returning 1`.execute(db);
        if (added.rows.length) {
          emit({
            projectId, taskId, kind: 'dep.added', actor: as.actor.id, actorRole: as.actor.role,
            requestId: opts.requestId, payload: { dependsOnId },
          });
        }
      });
    },

    async remove(taskId: string, dependsOnId: string, opts: WriteOptions = {}): Promise<void> {
      await client.transaction(async ({ db, emit }) => {
        await lockGraph(db, projectId);
        const task = await loadTask(db, projectId, taskId, true);
        await as.check('deps.remove', task.state, db);
        const removed = await sql`
          delete from taskgraph.task_deps
           where project_id = ${projectId} and task_id = ${taskId} and depends_on_id = ${dependsOnId}
          returning 1`.execute(db);
        if (!removed.rows.length) throw new NotFound('dependency', `${taskId} -> ${dependsOnId}`);
        emit({
          projectId, taskId, kind: 'dep.removed', actor: as.actor.id, actorRole: as.actor.role,
          requestId: opts.requestId, payload: { dependsOnId },
        });
      });
    },
  };
}

export function linksApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  return {
    /** A non-blocking reference from a to b, such as discovered-from or related. */
    async add(a: string, b: string, kind: string, opts: WriteOptions = {}): Promise<void> {
      if (!kind) throw new InvalidRequest('a link needs a kind');
      await client.transaction(async ({ db, emit }) => {
        const from = await loadTask(db, projectId, a, true);
        await loadTask(db, projectId, b);
        await as.check('links.add', from.state, db);
        const added = await sql`
          insert into taskgraph.task_links (project_id, a, b, kind) values (${projectId}, ${a}, ${b}, ${kind})
          on conflict do nothing returning 1`.execute(db);
        if (added.rows.length) {
          emit({
            projectId, taskId: a, kind: 'link.added', actor: as.actor.id, actorRole: as.actor.role,
            requestId: opts.requestId, payload: { b, kind },
          });
        }
      });
    },
  };
}

export function notesApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  return {
    /** A note on a task, kept as a `note` event in its history. */
    async add(taskId: string, text: string, opts: WriteOptions = {}): Promise<void> {
      if (!text) throw new InvalidRequest('a note needs text');
      await client.transaction(async ({ db, emit }) => {
        const task = await loadTask(db, projectId, taskId, true);
        await as.check('notes.add', task.state, db);
        emit({
          projectId, taskId, kind: 'note', actor: as.actor.id, actorRole: as.actor.role,
          requestId: opts.requestId, payload: { text },
        });
      });
    },
  };
}
