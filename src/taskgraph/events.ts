import { sql, type Transaction } from 'kysely';
import { LOCK_NAMESPACE } from './locks';

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
        payload: sql`cast(${JSON.stringify(e.payload ?? {})} as jsonb)`,
        request_id: e.requestId ?? null,
        at: e.at ?? sql`taskgraph.now()`,
      })))
      .returning('id')
      .execute();
    // bigint ids come back as strings from some drivers; keep them as strings
    ids.push(...rows.map(r => String(r.id)));
  }
  return ids;
}
