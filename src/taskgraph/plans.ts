import { sql, type Kysely } from 'kysely';
import type { ActorHandle } from './client';
import { toPlan, type PlanRow } from './reads';
import { loadTask, lockGraph, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import { jsonb, textArray } from './sql-values';
import { runValidators, type BuiltinContext, type PlanSnapshot } from './validators';
import { containerSettled, isTerminal, liveChildren } from './containers';
import { newPlanId } from './ids';
import { InvalidRequest, MoveRefused, NotFound, NotPermitted, ValidationError, type Finding } from './errors';
import type { NewEvent } from './events';
import type { Move } from './lifecycle';
import type { Plan, Task } from './types';

// Plans (engine spec, "Plans and validation"). A plan is what one planning
// session proposes and a developer approves as a unit; validate is the dry
// run the planner gets before anyone is asked to approve.

export type ValidationReport = { planId: string; ok: boolean; findings: Finding[] };
/** An approved plan, with the validators' warnings. */
export type ApprovedPlan = Plan & { findings: Finding[] };
/** The surface an approval or discard came through, e.g. cli or phalaka; kept on its event. */
export type ApprovalOptions = { via: string; requestId?: string };

/** Rolls the dry run's transaction back, carrying its result out. */
class DryRun {
  constructor(readonly report: ValidationReport) {}
}

/** The plan, its tasks, and the dependencies and links touching them. */
/**
 * With `lock` (approval), the graph lock and then the plan row are held first,
 * in the engine's lock order, so no edge, reparent or delete changes the
 * snapshot before the approval commits.
 */
export async function planSnapshot(db: Kysely<any>, projectId: string, planId: string, lock = false): Promise<PlanSnapshot & { plan: Plan }> {
  if (lock) await lockGraph(db, projectId);
  const p = await sql<PlanRow>`
    select * from taskgraph.plans where project_id = ${projectId} and id = ${planId}
    ${lock ? sql`for update` : sql``}`.execute(db);
  if (!p.rows[0]) throw new NotFound('plan', planId);
  const tasks = (await sql<TaskRow>`
    select ${TASK_COLUMNS} from taskgraph.tasks where project_id = ${projectId} and plan_id = ${planId}
     order by created_at, id`.execute(db)).rows.map(toTask);
  const ids = textArray(tasks.map(t => t.id));
  const deps = await sql<{ task_id: string; depends_on_id: string }>`
    select task_id, depends_on_id from taskgraph.task_deps
     where project_id = ${projectId} and (task_id = any(${ids}) or depends_on_id = any(${ids}))
     order by task_id, depends_on_id`.execute(db);
  const links = await sql<{ a: string; b: string; kind: string }>`
    select a, b, kind from taskgraph.task_links
     where project_id = ${projectId} and (a = any(${ids}) or b = any(${ids}))
     order by a, b, kind`.execute(db);
  return {
    plan: toPlan(p.rows[0]),
    tasks,
    deps: deps.rows.map(d => ({ taskId: d.task_id, dependsOnId: d.depends_on_id })),
    links: links.rows,
  };
}

/** What the built-in validators read from the project, in the transaction. */
export function builtinContext(as: ActorHandle, db: Kysely<any>): Omit<BuiltinContext, 'config'> {
  const projectId = as.project.id;
  return {
    tx: db as BuiltinContext['tx'],
    lifecycle: as.project.client.lifecycle,
    async exists(ids) {
      const r = await sql<{ id: string }>`
        select id from taskgraph.tasks where project_id = ${projectId} and id = any(${textArray(ids)})`.execute(db);
      return new Set(r.rows.map(x => x.id));
    },
    async withChildren(ids) {
      const r = await sql<{ id: string }>`
        select distinct parent_id as id from taskgraph.tasks
         where project_id = ${projectId} and parent_id = any(${textArray(ids)})`.execute(db);
      return new Set(r.rows.map(x => x.id));
    },
  };
}

/**
 * Makes a lifecycle move inside the caller's transaction on a task already
 * locked and in one of the move's from-states: the guard, the guarded update,
 * and the move's event. For approval and discard, which move many tasks at once.
 */
async function moveInTx(
  as: ActorHandle, db: Kysely<any>, emit: (e: NewEvent) => void, task: Task, move: Move, payload: Record<string, unknown>,
  requestId?: string,
): Promise<Task> {
  const projectId = as.project.id;
  const { lifecycle } = as.project.client;
  // Under the task's lock, as move() does: a container never closes over live children.
  if (isTerminal(lifecycle, move.to) && !isTerminal(lifecycle, task.state)) {
    const live = await liveChildren(db, projectId, task.id, lifecycle);
    if (live.length) throw new MoveRefused(task.id, task.state, 'ChildrenLive', [], live);
  }
  if (move.guard) {
    const verdict = await move.guard({ task, actor: as.actor, tx: db as never });
    if (verdict !== true) throw new MoveRefused(task.id, task.state, verdict);
  }
  const terminal = isTerminal(as.project.client.lifecycle, move.to);
  const boosted = move.boost ? sql`true` : move.clearsBoost ? sql`false` : sql`boosted`;
  const r = await sql<TaskRow>`
    update taskgraph.tasks
       set state = ${move.to}, boosted = ${boosted},
           closed_at = ${terminal ? sql`taskgraph.now()` : sql`closed_at`}, updated_at = taskgraph.now()
     where project_id = ${projectId} and id = ${task.id} and state = ${task.state}
    returning ${TASK_COLUMNS}`.execute(db);
  if (!r.rows[0]) throw new MoveRefused(task.id, task.state, 'WrongState');
  emit({
    projectId, taskId: task.id, planId: task.planId ?? undefined, kind: `move:${move.name}`,
    actor: as.actor.id, actorRole: as.actor.role, fromState: task.state, toState: move.to, payload, requestId,
  });
  return toTask(r.rows[0]);
}

/** Orders tasks so each comes after its children and the tasks waiting on it that are also in the set. */
function cancelOrder(tasks: Task[], deps: { taskId: string; dependsOnId: string }[]): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const before = new Map<string, string[]>(tasks.map(t => [t.id, []]));
  for (const t of tasks) if (t.parentId && byId.has(t.parentId)) before.get(t.parentId)!.push(t.id);
  for (const d of deps) if (byId.has(d.taskId) && byId.has(d.dependsOnId)) before.get(d.dependsOnId)!.push(d.taskId);
  const out: Task[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const b of [...before.get(id)!].sort()) visit(b);
    out.push(byId.get(id)!);
  };
  for (const t of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) visit(t.id);
  return out;
}

export function plansApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;

  const { lifecycle } = client;
  const approveMove = lifecycle.moves.find(m => m.name === lifecycle.hooks.onApprove)!;
  const discardMove = lifecycle.moves.find(m => m.name === lifecycle.hooks.onDiscard)!;
  const mayMove = (call: string, m: Move) => {
    if (!m.by.includes(as.actor.role)) throw new NotPermitted(call, as.actor.role);
  };
  /** The plan, locked with the graph, while it is still open for approval or discard. */
  const openPlan = async (db: Kysely<any>, planId: string) => {
    const snapshot = await planSnapshot(db, projectId, planId, true);
    const { approvedAt, discardedAt } = snapshot.plan;
    if (approvedAt || discardedAt) throw new InvalidRequest(`plan ${planId} is already ${approvedAt ? 'approved' : 'discarded'}`);
    return snapshot;
  };

  return {
    /** Starts a plan: what one planning session proposes, for a developer to approve as a unit. */
    async create(input: { title: string; meta?: Record<string, unknown> }, _opts: { requestId?: string } = {}): Promise<Plan> {
      if (!input?.title) throw new InvalidRequest('a plan needs a title');
      return client.transaction(async ({ db, emit }) => {
        await as.check('plans.create', undefined, db);
        let row: PlanRow | undefined;
        await newPlanId(db, projectId, async id => {
          const r = await sql<PlanRow>`
            insert into taskgraph.plans (project_id, id, title, meta)
            values (${projectId}, ${id}, ${input.title}, ${jsonb(input.meta ?? {})})
            on conflict do nothing returning *`.execute(db);
          row = r.rows[0];
          return !!row;
        });
        const plan = toPlan(row!);
        emit({
          projectId, planId: plan.id, kind: 'plan.created', actor: as.actor.id, actorRole: as.actor.role,
          requestId: _opts.requestId, payload: { title: plan.title },
        });
        return plan;
      });
    },

    /**
     * Runs every validator, and if none finds an error, fires onApprove on
     * every proposed task of the plan, all in one transaction; throws
     * ValidationError otherwise, and nothing opens. Returns the plan with the
     * warnings.
     */
    async approve(planId: string, opts: ApprovalOptions): Promise<ApprovedPlan> {
      if (!opts?.via) throw new InvalidRequest('an approval names the surface it came through (via)');
      mayMove('plans.approve', approveMove);
      return client.transaction(async ({ db, emit }) => {
        await as.assertVersion(db);
        const snapshot = await openPlan(db, planId);
        const findings = await runValidators(snapshot, builtinContext(as, db), client.validators, client.configFor(projectId));
        if (findings.some(f => f.severity === 'error')) throw new ValidationError(findings);
        for (const t of snapshot.tasks) {
          if (t.state !== lifecycle.create.state) continue;
          const task = await loadTask(db, projectId, t.id, true);
          if (approveMove.from.includes(task.state)) await moveInTx(as, db, emit, task, approveMove, { via: opts.via, planId });
        }
        const r = await sql<PlanRow>`
          update taskgraph.plans set approved_at = taskgraph.now(), approved_by = ${as.actor.id}
           where project_id = ${projectId} and id = ${planId} returning *`.execute(db);
        emit({
          projectId, planId, kind: 'plan.approved', actor: as.actor.id, actorRole: as.actor.role, requestId: opts.requestId,
          payload: { via: opts.via, findings, tasks: snapshot.tasks.length },
        });
        return { ...toPlan(r.rows[0]), findings };
      });
    },

    /**
     * Fires onDiscard on every proposed task of a plan never approved,
     * children before their container and waiting tasks before the ones they
     * wait on; refuses, naming them, when a live task outside the plan waits on
     * one inside, or sits under one.
     */
    async discard(planId: string, opts: ApprovalOptions): Promise<Plan> {
      if (!opts?.via) throw new InvalidRequest('a discard names the surface it came through (via)');
      mayMove('plans.discard', discardMove);
      return client.transaction(async ({ db, emit }) => {
        await as.assertVersion(db);
        const snapshot = await openPlan(db, planId);
        const going = snapshot.tasks.filter(t => t.state === lifecycle.create.state && discardMove.from.includes(t.state));
        const ids = new Set(going.map(t => t.id));
        const live = (s: string) => !lifecycle.states[s]?.terminal;
        // Anything left behind that waits on, or sits under, a task being cancelled.
        const waiting = await sql<{ id: string; on: string; state: string; parent: boolean }>`
          select d.task_id as id, d.depends_on_id as on, t.state, false as parent
            from taskgraph.task_deps d join taskgraph.tasks t on t.project_id = d.project_id and t.id = d.task_id
           where d.project_id = ${projectId} and d.depends_on_id = any(${textArray([...ids])})
          union all
          select t.id, t.parent_id as on, t.state, true as parent from taskgraph.tasks t
           where t.project_id = ${projectId} and t.parent_id = any(${textArray([...ids])})`.execute(db);
        for (const w of waiting.rows) {
          if (ids.has(w.id) || !live(w.state)) continue;
          const on = going.find(t => t.id === w.on)!;
          const blockers = waiting.rows.filter(x => x.on === w.on && x.parent === w.parent && !ids.has(x.id) && live(x.state)).map(x => x.id).sort();
          throw w.parent
            ? new MoveRefused(on.id, on.state, 'ChildrenLive', [], blockers)
            : new MoveRefused(on.id, on.state, 'DependentsLive', blockers);
        }
        // Parent rows before task rows, in the engine's lock order, so each
        // container's settled check sees every sibling.
        const parentIds = [...new Set(going.map(t => t.parentId).filter((x): x is string => !!x))].sort();
        if (parentIds.length) {
          await sql`select 1 from taskgraph.tasks where project_id = ${projectId} and id = any(${textArray(parentIds)})
                     order by id for update`.execute(db);
        }
        const parents = new Set<string>();
        for (const t of cancelOrder(going, snapshot.deps)) {
          const task = await loadTask(db, projectId, t.id, true);
          await moveInTx(as, db, emit, task, discardMove, { via: opts.via, planId });
          if (task.parentId && !ids.has(task.parentId)) parents.add(task.parentId);
        }
        for (const parent of [...parents].sort()) {
          if (isTerminal(lifecycle, discardMove.to) && await containerSettled(db, projectId, parent, lifecycle)) {
            emit({ projectId, taskId: parent, kind: 'children.settled', actor: as.actor.id, actorRole: as.actor.role });
          }
        }
        const r = await sql<PlanRow>`
          update taskgraph.plans set discarded_at = taskgraph.now(), discarded_by = ${as.actor.id}
           where project_id = ${projectId} and id = ${planId} returning *`.execute(db);
        emit({
          projectId, planId, kind: 'plan.discarded', actor: as.actor.id, actorRole: as.actor.role, requestId: opts.requestId,
          payload: { via: opts.via, cancelled: going.map(t => t.id) },
        });
        return toPlan(r.rows[0]);
      });
    },

    /**
     * Runs every validator over the plan as a dry run: the findings, and ok
     * when none is an error. It writes nothing, whatever the validators do.
     */
    async validate(planId: string): Promise<ValidationReport> {
      try {
        await client.transaction(async ({ db }) => {
          await as.check('plans.validate', undefined, db);
          const snapshot = await planSnapshot(db, projectId, planId);
          const findings = await runValidators(snapshot, builtinContext(as, db), client.validators, client.configFor(projectId));
          throw new DryRun({ planId, ok: !findings.some(f => f.severity === 'error'), findings });
        });
      } catch (err) {
        if (err instanceof DryRun) return err.report;
        throw err;
      }
      throw new Error('taskgraph: the dry run returned without a report');
    },
  };
}

/** tasks.approve: a lone task, with no plan, after the task-scope validators. */
export function approveTaskApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  const { lifecycle } = client;
  const approveMove = lifecycle.moves.find(m => m.name === lifecycle.hooks.onApprove)!;

  return async function approve(taskId: string, opts: ApprovalOptions): Promise<Task> {
    if (!opts?.via) throw new InvalidRequest('an approval names the surface it came through (via)');
    if (!approveMove.by.includes(as.actor.role)) throw new NotPermitted('tasks.approve', as.actor.role);
    return client.transaction(async ({ db, emit }) => {
      await as.assertVersion(db);
      const task = await loadTask(db, projectId, taskId, true);
      if (task.planId) throw new InvalidRequest(`task ${taskId} is in plan ${task.planId}; approve the plan`);
      if (!approveMove.from.includes(task.state)) throw new MoveRefused(taskId, task.state, 'WrongState');
      const snapshot: PlanSnapshot = { plan: null, tasks: [task], deps: [], links: [] };
      const findings = await runValidators(
        snapshot, builtinContext(as, db), client.validators, client.configFor(projectId), 'task');
      if (findings.some(f => f.severity === 'error')) throw new ValidationError(findings);
      return moveInTx(as, db, emit, task, approveMove, { via: opts.via }, opts.requestId);
    });
  };
}
