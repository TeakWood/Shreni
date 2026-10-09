import { sql } from 'kysely';
import type { ProjectHandle, Task } from '../../taskgraph';
import type { ShreniClient } from '../db/client';
import type { KshetraConfig } from '../../kshetra/config';
import { bd } from '../../sthapathi/beads';
import { engineStore } from '../../sthapathi/task-store';
import { openKshetraEngine } from './connect';
import { PR_NEEDS_FOLLOWUP_LABEL } from '../../sthapathi/pr-followup';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { lastEventId } from '../db/bundle';

// Shreni's reads on the task graph engine (engine spec, "API"; migration plan,
// "Replacing today's bd wrapper"): show, logs, export, status, drain
// classification and Phalaka read the engine through the same bd-shaped JSON
// they parse today, so each reader changes only where its rows come from.
// Still polling: change notifications come later.

/** The reads the CLI and Phalaka make, as `bd … --json` printed them. */
export interface TrackerReads {
  /** Tasks by bd status (comma-separated, or 'all'; default: every status but closed) and label. Every row, never capped. */
  list(filter?: { status?: string; label?: string; type?: string }): Promise<string>;
  /** Claimable work tasks, in claim order. */
  ready(): Promise<string>;
  /** The task, as an array holding it. */
  show(id: string): Promise<string>;
  /** The task's direct children. */
  children(id: string): Promise<string>;
  /** The project's last event id, its version for lot manifests and snapshots; null on beads. */
  lastEventId(): Promise<string | null>;
  /**
   * What people did on tasks, oldest first, in the shape of beads'
   * interactions.jsonl: every event by a developer, and the interactions the
   * importer kept from beads (BEADS_INTERACTION_EVENT). Empty on beads, where
   * the report reads the file.
   */
  interactions(): Promise<{ created_at: string; issue_id: string; kind: string; actor: string }[]>;
}

/**
 * The event kind the beads importer writes for each interaction it keeps from
 * beads' interactions.jsonl; it counts as a person acting whatever its actor's role.
 */
export const BEADS_INTERACTION_EVENT = 'beads.interaction';

/** The label a task waiting on its PR carries, as bd's awaiting-merge label did. */
const AWAITING_MERGE = 'awaiting-merge';

/** The bd status an engine state reads as. */
export const BD_STATUS: Record<string, string> = {
  proposed: 'proposed', open: 'open', claimed: 'in_progress', waiting: 'in_progress',
  blocked: 'blocked', parked: 'deferred', done: 'closed', cancelled: 'closed',
};

/** The engine states a bd status filter names. */
function statesFor(status: string | undefined): string[] {
  if (status === 'all') return Object.keys(BD_STATUS);
  const wanted = status ? status.split(',').map(s => s.trim()).filter(Boolean) : ['proposed', 'open', 'in_progress', 'blocked', 'deferred'];
  return Object.keys(BD_STATUS).filter(s => wanted.includes(BD_STATUS[s]));
}

/** A dependency's bd status: only a finished one reads as closed, since a cancelled one still blocks on the engine. */
function depStatus(state: string): string {
  if (taskLifecycle.states[state]?.satisfiesDeps) return 'closed';
  return BD_STATUS[state] === 'closed' ? state : (BD_STATUS[state] ?? state);
}

export function engineReads(shreni: ShreniClient, tg: ProjectHandle): TrackerReads {
  /**
   * Each task's notes, oldest first, one per line, with its flag reasons among
   * them (bd appended a flag's reason to the notes, which drain classification
   * and logs read); and the reason of the move that closed it.
   */
  const notesOf = async (ids: string[]) => {
    const notes = new Map<string, string>();
    const closeReason = new Map<string, string>();
    if (!ids.length) return { notes, closeReason };
    const r = await sql<{ task_id: string; kind: string; text: string | null; reason: string | null; to_state: string | null }>`
      select e.task_id, e.kind, e.payload ->> 'text' as text, e.payload ->> 'reason' as reason, e.to_state
        from taskgraph.events e
       where e.project_id = ${tg.id} and e.task_id = any(${sql.val(ids)}::text[])
         and (e.kind = 'note' or (e.kind like 'move:%' and e.payload ? 'reason'))
       order by e.id`.execute(shreni.db);
    const lines = new Map<string, string[]>();
    for (const row of r.rows) {
      const line = row.kind === 'note' ? row.text : row.kind === 'move:flag' ? row.reason : null;
      if (line) lines.set(row.task_id, [...(lines.get(row.task_id) ?? []), line]);
      if (row.kind !== 'note' && row.reason && row.to_state && taskLifecycle.states[row.to_state]?.terminal) {
        closeReason.set(row.task_id, row.reason);
      }
    }
    for (const [id, l] of lines) notes.set(id, l.join('\n'));
    return { notes, closeReason };
  };
  /** Each task's blocking dependencies, with their titles and states. */
  const depsOf = async (ids: string[]) => {
    if (!ids.length) return new Map<string, { id: string; title: string; state: string }[]>();
    const r = await sql<{ task_id: string; id: string; title: string; state: string }>`
      select d.task_id, t.id, t.title, t.state from taskgraph.task_deps d
        join taskgraph.tasks t on t.project_id = d.project_id and t.id = d.depends_on_id
       where d.project_id = ${tg.id} and d.task_id = any(${sql.val(ids)}::text[])
       order by d.task_id, t.id`.execute(shreni.db);
    const out = new Map<string, { id: string; title: string; state: string }[]>();
    for (const row of r.rows) out.set(row.task_id, [...(out.get(row.task_id) ?? []), row]);
    return out;
  };
  /** Each task's acceptance checks, rendered as bd's acceptance criteria. */
  const acceptanceOf = async (ids: string[]) => {
    if (!ids.length) return new Map<string, string>();
    const rows = (await sql<{ task_id: string; given: string; when: string; then: string }>`
      select task_id, given, "when", "then" from shreni.acceptance_checks
       where project_id = ${tg.id} and task_id = any(${sql.val(ids)}::text[])
       order by created_at, id`.execute(shreni.db)).rows;
    const out = new Map<string, string[]>();
    for (const c of rows) out.set(c.task_id!, [...(out.get(c.task_id!) ?? []), `- Given ${c.given}, when ${c.when}, then ${c.then}`]);
    return new Map([...out].map(([id, lines]) => [id, lines.join('\n')]));
  };

  // A task waiting on its PR reads as awaiting merge; one followUp reopened
  // (boosted) as a follow-up while it is open or worked, not once flagged or parked.
  const labelsOf = (t: Task) => [
    ...t.tags, ...(t.state === 'waiting' ? [AWAITING_MERGE] : []),
    ...(t.boosted && ['open', 'claimed'].includes(t.state) ? [PR_NEEDS_FOLLOWUP_LABEL] : []),
  ];

  /** Each follow-up's round, from its PR watermark on the attempts (bd kept it in notes). */
  const followupRoundOf = async (ids: string[]) => {
    if (!ids.length) return new Map<string, number>();
    const r = await sql<{ task_id: string; round: number }>`
      select distinct on (a.task_id) a.task_id, (e.gates -> 'prFollowup' ->> 'round')::int as round
        from taskgraph.attempts a join shreni.attempt_evidence e on e.attempt_id = a.id
       where a.project_id = ${tg.id} and a.task_id = any(${sql.val(ids)}::text[]) and e.gates ? 'prFollowup'
       order by a.task_id, a.started_at desc, a.id desc`.execute(shreni.db);
    return new Map(r.rows.map(x => [x.task_id, x.round]));
  };

  /** Tasks as bd's JSON rows. */
  const rows = async (tasks: Task[]): Promise<Record<string, unknown>[]> => {
    const ids = tasks.map(t => t.id);
    const [{ notes, closeReason }, deps, acceptance, rounds] = await Promise.all([
      notesOf(ids), depsOf(ids), acceptanceOf(ids), followupRoundOf(tasks.filter(t => t.boosted).map(t => t.id)),
    ]);
    return tasks.map(t => ({
      id: t.id, title: t.title, description: t.description ?? '',
      status: BD_STATUS[t.state] ?? t.state, state: t.state, priority: t.priority,
      issue_type: t.kind === 'container' ? 'epic' : (t.category ?? 'task'),
      labels: labelsOf(t),
      ...(t.parentId ? { parent: t.parentId } : {}),
      ...(notes.has(t.id) ? { notes: notes.get(t.id) } : {}),
      // Checks when it has them; an imported task keeps beads' free text in its spec.
      ...(acceptance.has(t.id) ? { acceptance_criteria: acceptance.get(t.id) }
        : typeof t.spec.acceptanceCriteria === 'string' ? { acceptance_criteria: t.spec.acceptanceCriteria } : {}),
      ...(typeof t.spec.design === 'string' ? { design: t.spec.design } : {}),
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      ...(t.closedAt ? { closed_at: t.closedAt.toISOString() } : {}),
      ...(closeReason.has(t.id) ? { close_reason: closeReason.get(t.id) } : {}),
      ...(rounds.has(t.id) ? { followup_round: rounds.get(t.id) } : {}),
      // Both shapes bd has printed: show's ({ id, status, dependency_type }) and list's ({ issue_id, depends_on_id, type }).
      dependencies: (deps.get(t.id) ?? []).map(d => ({
        id: d.id, title: d.title, status: depStatus(d.state),
        dependency_type: 'blocks', type: 'blocks', issue_id: t.id, depends_on_id: d.id,
      })),
    }));
  };
  const json = async (tasks: Task[]) => JSON.stringify(await rows(tasks));

  return {
    async list(filter = {}) {
      let tasks = await tg.tasks.list({
        states: statesFor(filter.status), orderBy: 'created',
        ...(filter.type === 'epic' ? { kind: 'container' as const } : {}),
      });
      if (filter.label) tasks = tasks.filter(t => labelsOf(t).includes(filter.label!));
      return json(tasks);
    },
    async ready() {
      return json(await tg.ready({ kind: 'work' }));
    },
    async show(id) {
      const [task] = await tg.tasks.list({ ids: [id] });
      if (!task) throw new Error(`no task ${id}`);
      return json([task]);
    },
    async children(id) {
      return json(await tg.tasks.list({ parent: id, orderBy: 'created' }));
    },
    lastEventId: () => lastEventId(shreni, tg.id),
    async interactions() {
      const r = await sql<{ at: Date; task_id: string; kind: string; actor: string }>`
        select e.at, e.task_id, e.kind, e.actor from taskgraph.events e
         where e.project_id = ${tg.id} and e.task_id is not null
           and (e.actor_role = 'developer' or e.kind = ${BEADS_INTERACTION_EVENT})
         order by e.id`.execute(shreni.db);
      return r.rows.map(e => ({ created_at: new Date(e.at).toISOString(), issue_id: e.task_id, kind: e.kind, actor: e.actor }));
    },
  };
}

/** bd's reads, for a Kshetra still on beads. */
function bdReads(kshetra: KshetraConfig): TrackerReads {
  const c = bd(kshetra);
  return {
    list: (f = {}) => c.list({ ...(f.status ? { status: f.status } : {}), ...(f.label ? { label: f.label } : {}), ...(f.type ? { type: f.type } : {}) }),
    ready: () => c.ready(),
    show: id => c.show(id),
    children: id => c.children(id),
    lastEventId: async () => null,
    interactions: async () => [],
  };
}

/**
 * Runs `fn` with the Kshetra's reads: the engine's when it names an engine
 * project (the worker's own connection when it is open in this process, else
 * one opened for the call and closed after), else bd's.
 */
export async function withTrackerReads<T>(
  kshetra: KshetraConfig, fn: (r: TrackerReads) => Promise<T>,
  /** Keep the connection for later calls (a long-lived reader such as Phalaka). */
  opts: { shared?: boolean } = {},
): Promise<T> {
  if (!kshetra.project) return fn(bdReads(kshetra));
  const reads = engineStore(kshetra)?.reads;
  if (reads) return fn(reads);
  if (opts.shared) return fn(await sharedReads(kshetra));
  const conn = await openKshetraEngine(kshetra, { name: 'shreni-read' });
  try {
    return await fn(engineReads(conn.shreni, conn.shreni.tg.project(kshetra.project)));
  } finally {
    // A failed close doesn't turn a good read into a failure.
    await conn.close().catch(() => {});
  }
}

/** Connections a long-lived reader keeps, one per Kshetra and project, for the life of the process. */
const shared = new Map<string, Promise<{ reads: TrackerReads; close(): Promise<void> }>>();

async function sharedReads(kshetra: KshetraConfig): Promise<TrackerReads> {
  const key = `${kshetra.id}:${kshetra.project}`;
  let entry = shared.get(key);
  if (!entry) {
    entry = openKshetraEngine(kshetra, { name: 'shreni-read' })
      .then(conn => ({ reads: engineReads(conn.shreni, conn.shreni.tg.project(kshetra.project!)), close: conn.close }));
    // A failed open isn't kept, so the next read tries again.
    entry.catch(() => shared.delete(key));
    shared.set(key, entry);
  }
  return (await entry).reads;
}

