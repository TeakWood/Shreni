import { sql, type Kysely } from 'kysely';
import type { ActorHandle, ProjectHandle } from './client';
import type { StoredLifecycle } from './lifecycle';
import { checkPermission } from './permissions';
import { lockGraph } from './tasks';
import { MIGRATIONS } from './migrations';
import { InvalidRequest, NotFound } from './errors';

// Lifecycle versions (engine spec, "Versions and upgrades"): diff previews
// what activating a version would change; activate applies it in one
// transaction. Both work from the stored definitions, so a diff can be read by
// any process, and a rollback is activating an older version.

export type LifecycleDiff = {
  from: { name: string; version: number };
  to: { name: string; version: number };
  states: { added: string[]; removed: string[] };
  moves: { added: string[]; removed: string[] };
  /** Moves kept by name whose roles changed. */
  roles: { move: string; added: string[]; removed: string[] }[];
  /** Moves kept by name whose guard changed, by name. */
  guards: { move: string; from: string | null; to: string | null }[];
  /** Tasks the migrate map moves, after any lease is ended. */
  tasks: { id: string; from: string; to: string }[];
  /** States the target lacks and doesn't map, with the tasks in them; activation refuses while any is listed. */
  unmapped: { state: string; tasks: string[] }[];
  /** Every lease held; a live one refuses activation unless forced. */
  leases: { taskId: string; attemptId: string; worker: string; expiresAt: Date; live: boolean }[];
  /** States kept whose flags change (terminal, satisfiesDeps, claimable, leased). */
  flags: { state: string; from: Record<string, true>; to: Record<string, true> }[];
  /** Moves kept by name whose from, to, boost or clearsBoost change. */
  changedMoves: string[];
  /** Hooks that change, by name. */
  hooks: string[];
  /** Calls whose permission rules change. */
  permissions: string[];
  /** The create rules change. */
  create: boolean;
  /** What the result would break: live children under a closed container, tasks waiting on work that can't satisfy them. Activation refuses while any is listed. */
  broken: string[];
};

/** The diff, plus every task change activation makes: lease endings as well as the map's moves. */
type Plan = LifecycleDiff & {
  expiry: { move: string; to: string; boost: boolean; clearsBoost: boolean };
  changes: { id: string; from: string; to: string }[];
  /** Containers the result settles: all children terminal now, not before. */
  settles: string[];
};

/** JSON with keys sorted and listed values sorted, so order means nothing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v.map(canonical).sort());
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

async function storedLifecycle(db: Kysely<any>, name: string, version: number): Promise<StoredLifecycle> {
  const r = await sql<{ definition: StoredLifecycle }>`
    select definition from taskgraph.lifecycles where name = ${name} and version = ${version}`.execute(db);
  if (!r.rows[0]) throw new NotFound('lifecycle', `${name}@${version}`);
  return r.rows[0].definition;
}

const minus = (a: readonly string[], b: readonly string[]) => a.filter(x => !b.includes(x)).sort();

/** What activating `version` would do to the project, read in `db` (locked rows, inside activate). */
async function plan(db: Kysely<any>, projectId: string, version: number, lock: boolean): Promise<Plan> {
  const p = await sql<{ lifecycle_name: string; lifecycle_version: number }>`
    select lifecycle_name, lifecycle_version from taskgraph.projects where id = ${projectId}
    ${lock ? sql`for update` : sql``}`.execute(db);
  if (!p.rows[0]) throw new NotFound('project', projectId);
  const { lifecycle_name: name, lifecycle_version: current } = p.rows[0];
  const from = await storedLifecycle(db, name, current);
  const to = await storedLifecycle(db, name, version);

  const fromStates = Object.keys(from.states);
  const toStates = Object.keys(to.states);
  const fromMoves = new Map(from.moves.map(m => [m.name, m]));
  const toMoves = new Map(to.moves.map(m => [m.name, m]));
  const kept = [...toMoves.keys()].filter(n => fromMoves.has(n)).sort();

  // A lease ends as expiry would end it under the active version.
  const expiryMove = fromMoves.get(from.hooks.onLeaseExpiry)!;
  const tasks = await sql<{ id: string; state: string; parent_id: string | null; kind: string; lease_attempt_id: string | null;
                            lease_expires_at: Date | null; worker: string | null; live: boolean | null }>`
    select t.id, t.state, t.parent_id, t.kind, t.lease_attempt_id, t.lease_expires_at, a.worker,
           t.lease_expires_at > taskgraph.now() as live
      from taskgraph.tasks t
      left join taskgraph.attempts a on a.project_id = t.project_id and a.id = t.lease_attempt_id
     where t.project_id = ${projectId}
     order by t.id
     ${lock ? sql`for update of t` : sql``}`.execute(db);

  const deps = await sql<{ task_id: string; depends_on_id: string }>`
    select task_id, depends_on_id from taskgraph.task_deps where project_id = ${projectId} order by task_id, depends_on_id`.execute(db);
  // The migrate map is written for upgrading from the version before; a
  // rollback refuses tasks in states the older version lacks instead.
  const map = version > current ? to.migrate ?? {} : {};

  const moved: LifecycleDiff['tasks'] = [];
  const changes: Plan['changes'] = [];
  const unmapped = new Map<string, string[]>();
  for (const t of tasks.rows) {
    const state = t.lease_attempt_id ? expiryMove.to : t.state;
    if (toStates.includes(state)) {
      if (state !== t.state) changes.push({ id: t.id, from: t.state, to: state });
      continue;
    }
    const target = map[state];
    if (target) {
      moved.push({ id: t.id, from: t.state, to: target });
      changes.push({ id: t.id, from: t.state, to: target });
    } else {
      unmapped.set(state, [...(unmapped.get(state) ?? []), t.id]);
    }
  }

  // Check the result against the new version's flags.
  const after = new Map(tasks.rows.map(t => [t.id, t.state]));
  for (const c of changes) after.set(c.id, c.to);
  const flag = (s: string, f: 'terminal' | 'satisfiesDeps' | 'leased') => !!to.states[s]?.[f];
  const wasTerminal = (s: string) => !!from.states[s]?.terminal;
  const broken: string[] = [];
  for (const t of tasks.rows) {
    const s = after.get(t.id)!;
    if (unmapped.size) break; // the states aren't known yet
    if (flag(s, 'leased')) broken.push(`task ${t.id} would be ${s}, the leased state, without a lease`);
    if (t.parent_id && flag(after.get(t.parent_id)!, 'terminal') && !flag(s, 'terminal')) {
      broken.push(`task ${t.parent_id} would be ${after.get(t.parent_id)} with a live child, ${t.id}`);
    }
  }
  if (!unmapped.size) {
    for (const d of deps.rows) {
      const target = after.get(d.depends_on_id)!;
      if (!flag(after.get(d.task_id)!, 'terminal') && flag(target, 'terminal') && !flag(target, 'satisfiesDeps')) {
        broken.push(`task ${d.task_id} waits on ${d.depends_on_id}, which would be ${target}`);
      }
    }
  }
  const settles = unmapped.size ? [] : tasks.rows.filter(t => {
    const kids = tasks.rows.filter(k => k.parent_id === t.id);
    return t.kind === 'container' && kids.length > 0
      && kids.every(k => flag(after.get(k.id)!, 'terminal'))
      && !kids.every(k => wasTerminal(k.state));
  }).map(t => t.id);

  const keptStates = toStates.filter(st => fromStates.includes(st)).sort();
  const moveShape = (m: (typeof from.moves)[number]) => canonical({ from: m.from, to: m.to, boost: m.boost, clearsBoost: m.clearsBoost });
  const calls = [...new Set([...Object.keys(from.permissions), ...Object.keys(to.permissions)])].sort();
  const hookNames = [...new Set([...Object.keys(from.hooks), ...Object.keys(to.hooks)])].sort();

  return {
    from: { name, version: current },
    to: { name, version },
    states: { added: minus(toStates, fromStates), removed: minus(fromStates, toStates) },
    moves: { added: minus([...toMoves.keys()], [...fromMoves.keys()]), removed: minus([...fromMoves.keys()], [...toMoves.keys()]) },
    roles: kept.flatMap(n => {
      const added = minus(toMoves.get(n)!.by, fromMoves.get(n)!.by);
      const removed = minus(fromMoves.get(n)!.by, toMoves.get(n)!.by);
      return added.length || removed.length ? [{ move: n, added, removed }] : [];
    }),
    guards: kept.flatMap(n => {
      const a = (fromMoves.get(n)!.guard as string | undefined) ?? null;
      const b = (toMoves.get(n)!.guard as string | undefined) ?? null;
      return a !== b ? [{ move: n, from: a, to: b }] : [];
    }),
    tasks: moved,
    unmapped: [...unmapped].map(([state, ids]) => ({ state, tasks: ids })),
    leases: tasks.rows.filter(t => t.lease_attempt_id).map(t => ({
      taskId: t.id, attemptId: t.lease_attempt_id!, worker: t.worker ?? '', expiresAt: t.lease_expires_at!, live: !!t.live,
    })),
    flags: keptStates.filter(st => canonical(from.states[st]) !== canonical(to.states[st]))
      .map(st => ({ state: st, from: from.states[st] as Record<string, true>, to: to.states[st] as Record<string, true> })),
    changedMoves: kept.filter(n => moveShape(fromMoves.get(n)!) !== moveShape(toMoves.get(n)!)),
    hooks: hookNames.filter(h => canonical((from.hooks as any)[h]) !== canonical((to.hooks as any)[h])),
    permissions: calls.filter(c => canonical((from.permissions as any)[c]) !== canonical((to.permissions as any)[c])),
    create: canonical(from.create) !== canonical(to.create),
    broken,
    expiry: { move: expiryMove.name, to: expiryMove.to, boost: !!expiryMove.boost, clearsBoost: !!expiryMove.clearsBoost },
    changes,
    settles,
  };
}

export function diffApi(tg: ProjectHandle) {
  return {
    /** What activating `version` would change; any process may read it. */
    async diff(version: number): Promise<LifecycleDiff> {
      await tg.client.need(MIGRATIONS[0].name);
      const { expiry: _e, changes: _c, settles: _s, ...diff } = await plan(tg.client.db, tg.id, version, false);
      return diff;
    },
  };
}

export function activateApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  const { lifecycle } = client;

  return {
    /**
     * Makes `version` the project's active lifecycle: ends leases as expiry
     * would (refused while one is live, unless force), moves tasks along the
     * migrate map, and writes lifecycle.upgraded. Only the version this
     * process runs can be activated, since its code holds the guards.
     */
    async activate(version: number, opts: { force?: boolean; requestId?: string } = {}): Promise<void> {
      if (version !== lifecycle.version) {
        throw new InvalidRequest(`this process runs ${lifecycle.name}@${lifecycle.version}; activate ${version} from a process that runs it`);
      }
      for (const m of MIGRATIONS) await client.need(m.name);
      checkPermission(lifecycle, 'lifecycles.activate', as.actor.role);

      // Stamped with the target version: the project row is updated first, so
      // the version fence sees the new version on every write after it.
      await client.transaction(async ({ db, emit }) => {
        await lockGraph(db, projectId);
        const p = await plan(db, projectId, version, true);
        if (p.from.version === version) throw new InvalidRequest(`project ${projectId} is already on ${lifecycle.name}@${version}`);
        const live = p.leases.filter(l => l.live);
        if (live.length && !opts.force) {
          throw new InvalidRequest(`live leases on ${live.map(l => `${l.taskId} (worker ${l.worker})`).join(', ')}; wait for them, or force`);
        }
        if (p.unmapped.length) {
          throw new InvalidRequest(`${lifecycle.name}@${version} has no state ${p.unmapped.map(u => `${u.state} (tasks ${u.tasks.join(', ')})`).join(', ')}, and no migrate entry for it`);
        }
        if (p.broken.length) throw new InvalidRequest(`activating ${version} would break the graph: ${p.broken.join('; ')}`);

        await sql`update taskgraph.projects set lifecycle_version = ${version} where id = ${projectId}`.execute(db);
        await sql`select set_config('taskgraph.activating', ${projectId}, true)`.execute(db);
        for (const l of p.leases) {
          await sql`update taskgraph.attempts set ended_at = taskgraph.now(), outcome = ${p.expiry.move}
                     where id = ${l.attemptId} and ended_at is null`.execute(db);
        }
        const leased = new Map(p.leases.map(l => [l.taskId, l.attemptId]));
        const terminal = (s: string) => !!lifecycle.states[s]?.terminal;
        for (const t of p.changes) {
          await sql`update taskgraph.tasks
                       set state = ${t.to}, lease_attempt_id = null, lease_expires_at = null,
                           boosted = ${!leased.has(t.id) ? sql`boosted` : p.expiry.boost ? sql`true` : p.expiry.clearsBoost ? sql`false` : sql`boosted`},
                           closed_at = ${terminal(t.to) ? sql`coalesce(closed_at, taskgraph.now())` : sql`null`},
                           updated_at = taskgraph.now()
                     where project_id = ${projectId} and id = ${t.id}`.execute(db);
          emit({
            projectId, taskId: t.id, attemptId: leased.get(t.id), kind: 'lifecycle.upgraded',
            actor: as.actor.id, actorRole: as.actor.role, fromState: t.from, toState: t.to,
          });
        }
        for (const c of p.settles) {
          emit({ projectId, taskId: c, kind: 'children.settled', actor: as.actor.id, actorRole: as.actor.role });
        }
        emit({
          projectId, kind: 'lifecycle.upgraded', actor: as.actor.id, actorRole: as.actor.role,
          payload: {
            name: lifecycle.name, from: p.from.version, to: version, force: !!opts.force,
            moved: p.changes.length, leasesEnded: p.leases.map(l => ({ taskId: l.taskId, worker: l.worker })),
          },
          requestId: opts.requestId,
        });
      });
    },
  };
}
