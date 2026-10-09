import { sql, type Transaction } from 'kysely';
import { LOCK_NAMESPACE } from './locks';
import { jsonb, timestamp } from './sql-values';

// Event writes (engine spec, "Events and history"). A transaction buffers its
// events and writes them last, under each project's events lock held until
// commit, so a project's event ids commit in order and a reader following
// events.since(cursor) never skips one.

export interface NewEvent {
  projectId: string;
  /** task.created, plan.approved, move:<name>, dep.added, note, … */
  kind: string;
  actor: string;
  actorRole: string;
  taskId?: string;
  planId?: string;
  attemptId?: string;
  fromState?: string;
  toState?: string;
  payload?: Record<string, unknown>;
  /** On a write's first event, when the caller passed one. */
  requestId?: string;
  /** Defaults to now; an import keeps the original time. */
  at?: Date;
}

/** The channel every event write notifies on, with { project, id } for the project's highest new event. */
export const NOTIFY_CHANNEL = 'taskgraph';

// About 12 parameters per event; well under Postgres's 65,535 per statement.
const CHUNK = 1000;

/**
 * Takes the events lock of every project involved, then inserts the events in
 * order; returns their ids. Takes a Transaction because the locks must be held
 * until commit.
 */
export async function writeEvents(tx: Transaction<any>, events: readonly NewEvent[]): Promise<string[]> {
  if (events.length === 0) return [];
  // Always the last lock a transaction takes; sorted, so two multi-project
  // transactions take them in the same order.
  for (const projectId of [...new Set(events.map(e => e.projectId))].sort()) {
    await sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE.events}, hashtext(${projectId}))`.execute(tx);
  }
  const ids: string[] = [];
  for (let i = 0; i < events.length; i += CHUNK) {
    const rows = await tx
      .withSchema('taskgraph')
      .insertInto('events')
      .values(events.slice(i, i + CHUNK).map(e => ({
        project_id: e.projectId,
        task_id: e.taskId ?? null,
        plan_id: e.planId ?? null,
        attempt_id: e.attemptId ?? null,
        kind: e.kind,
        actor: e.actor,
        actor_role: e.actorRole,
        from_state: e.fromState ?? null,
        to_state: e.toState ?? null,
        payload: jsonb(e.payload ?? {}),
        request_id: e.requestId ?? null,
        at: e.at ? timestamp(e.at) : sql`taskgraph.now()`,
      })))
      .returning('id')
      .execute();
    // bigint ids come back as strings from some drivers; keep them as strings
    ids.push(...rows.map(r => String(r.id)));
  }
  // The wake-up hint: delivered on commit only, ids only; listeners read the rows (events.since).
  const last = new Map<string, string>();
  events.forEach((e, i) => last.set(e.projectId, ids[i]));
  for (const [project, id] of last) {
    await sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify({ project, id })})`.execute(tx);
  }
  return ids;
}
