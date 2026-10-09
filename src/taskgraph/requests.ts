import { sql, type Kysely } from 'kysely';
import { InvalidRequest } from './errors';

// Idempotent retries (engine spec, "Claiming and leases", Idempotent
// retries). A write's first event carries the caller's request id, under a
// unique index per project, and names what the write produced (its task and
// attempt). Repeating the write with that id returns the first result instead
// of acting again. A refused write rolls back and stores nothing, so its retry
// is judged afresh, and so does a write that changes nothing. Two concurrent
// writes with one id: the second loses, at the unique index or at a row lock,
// rolls back, and returns the first's result.

const NONE = Symbol('none');

export type PriorWrite = {
  kind: string; actor: string; taskId: string | null; planId: string | null; attemptId: string | null;
  payload: Record<string, unknown>;
};

async function priorWrite(db: Kysely<any>, projectId: string, requestId: string): Promise<PriorWrite | undefined> {
  const r = await sql<{ kind: string; actor: string; task_id: string | null; plan_id: string | null; attempt_id: string | null;
                        payload: Record<string, unknown> }>`
    select kind, actor, task_id, plan_id, attempt_id, payload from taskgraph.events
     where project_id = ${projectId} and request_id = ${requestId}`.execute(db);
  const row = r.rows[0];
  return row && { kind: row.kind, actor: row.actor, taskId: row.task_id, planId: row.plan_id, attemptId: row.attempt_id, payload: row.payload };
}

/**
 * Runs a write once per request id. `kind` is the event kind the write puts
 * the request id on. The id replays only for the same kind of write, by the
 * same actor, on the same task when the write names one; anything else is
 * InvalidRequest. `replay` turns the first write's event into the result.
 */
export async function once<T>(
  db: Kysely<any>, projectId: string, requestId: string | undefined, kind: string,
  expected: { actor: string; taskId?: string; planId?: string },
  act: () => Promise<T>, replay: (prior: PriorWrite) => Promise<T>,
): Promise<T> {
  if (requestId === undefined) return act();
  if (!requestId) throw new InvalidRequest('a request id must not be empty');
  const replayed = async (): Promise<T | typeof NONE> => {
    const prior = await priorWrite(db, projectId, requestId);
    if (!prior) return NONE;
    if (prior.kind !== kind) {
      throw new InvalidRequest(`request id ${requestId} was used by another write (${prior.kind}), not ${kind}`);
    }
    if (prior.actor !== expected.actor) throw new InvalidRequest(`request id ${requestId} was used by another actor`);
    if (expected.planId !== undefined && prior.planId !== expected.planId) {
      throw new InvalidRequest(`request id ${requestId} was used on plan ${prior.planId}, not ${expected.planId}`);
    }
    if (expected.taskId !== undefined && prior.taskId !== expected.taskId) {
      throw new InvalidRequest(`request id ${requestId} was used on task ${prior.taskId}, not ${expected.taskId}`);
    }
    return replay(prior);
  };
  const first = await replayed();
  if (first !== NONE) return first;
  try {
    return await act();
  } catch (err) {
    // A duplicate in flight loses at the unique index, or at a row lock and
    // then a state check; either way, if the first write with this id has
    // committed by now, return its result.
    const second = await replayed();
    if (second === NONE) throw err;
    return second;
  }
}
