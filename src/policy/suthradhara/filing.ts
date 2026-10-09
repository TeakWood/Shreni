import { sql } from 'kysely';
import { InvalidRequest, NotFound, type ActorHandle, type Finding, type Plan, type ProjectHandle, type Task } from '../../taskgraph';
import type { ShreniClient } from '../db/client';
import type { KshetraEngine } from '../sthapathi/connect';
import { checksOf } from '../task/by-hand';

// Suthradhara on the engine (policy spec, "Approval: humans only"). Shreni's
// own process creates the plan before the session starts; the session files
// into it with the planner role through `shreni plan`, so everything it files
// lands proposed in that one plan. Only the developer approves or discards it,
// from the launcher's menu or `shreni task approve`, never the agent.

/** The planner Suthradhara acts as. */
export const PLANNER = { id: 'suthradhara', role: 'planner' } as const;

/** The env var naming the plan a planning session files into. */
export const PLAN_ENV = 'SHRENI_PLAN';
/** The env var naming the Kshetra whose project the session files into. */
export const KSHETRA_ENV = 'SHRENI_KSHETRA';

export type Check = { given: string; when: string; then: string };

export type PlanTaskInput = {
  title: string;
  description?: string;
  parent?: string;
  priority?: number;
  epic?: boolean;
  category?: string;
  checks?: Check[];
};

/**
 * The task, if it belongs to the plan and is still proposed. A session's
 * commands name its plan, so they change only that plan's proposed tasks; the
 * plan comes from the session's env, which is an accident guard, not a
 * security boundary (policy spec, "Approval: humans only").
 */
async function inPlan(tg: ProjectHandle, planId: string, id: string): Promise<Task> {
  const t = await tg.tasks.get(id);
  if (t.planId !== planId) throw new InvalidRequest(`${id} isn't in plan ${planId}; a planning session changes only its own plan`);
  if (t.state !== 'proposed') throw new InvalidRequest(`${id} is ${t.state}: once approved, a change is a new plan`);
  return t;
}

/** Files a task into the plan, proposed, with its acceptance checks. */
export async function addPlanTask(shreni: ShreniClient, tg: ProjectHandle, planId: string, input: PlanTaskInput): Promise<Task> {
  const planner = tg.as(PLANNER);
  if (input.parent) await inPlan(tg, planId, input.parent);
  if (input.epic && input.checks?.length) throw new InvalidRequest('an epic takes no checks; give its tasks the checks');
  const task = await planner.tasks.create({
    title: input.title, plan: planId,
    ...(input.description ? { description: input.description } : {}),
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.epic ? { kind: 'container' as const } : {}),
  });
  if (input.checks?.length) {
    try {
      await writeChecks(shreni, tg.id, task.id, input.checks);
    } catch (err) {
      // The engine's create can't join Shreni's transaction: a task whose checks didn't land is removed.
      try {
        await planner.tasks.delete(task.id);
      } catch (gone) {
        throw new Error(`filed ${task.id}, but its checks failed (${(err as Error).message}) and it could not be removed (${(gone as Error).message})`);
      }
      throw err;
    }
  }
  return task;
}

/** Writes the task's checks; with `replace`, in place of its current ones, in the same transaction. */
async function writeChecks(shreni: ShreniClient, projectId: string, taskId: string, checks: Check[], replace = false) {
  await shreni.transaction(async db => {
    if (replace) await db.deleteFrom('shreni.acceptance_checks').where('project_id', '=', projectId).where('task_id', '=', taskId).execute();
    if (!checks.length) return;
    await db.insertInto('shreni.acceptance_checks')
      // One transaction shares one now(), so each check is a microsecond on, to read back in order.
      .values(checks.map((c, i) => ({
        project_id: projectId, task_id: taskId, ...c, mode: 'auto',
        created_at: sql<Date>`now() + ${i} * interval '1 microsecond'`,
      })))
      .execute();
  });
}

/** Edits a proposed task of the plan; `checks`, when given, replace its checks. */
export async function updatePlanTask(
  shreni: ShreniClient, tg: ProjectHandle, planId: string, id: string,
  patch: { title?: string; description?: string; priority?: number; checks?: Check[] },
): Promise<Task> {
  await inPlan(tg, planId, id);
  const { checks, ...fields } = patch;
  const task = Object.keys(fields).length ? await tg.as(PLANNER).tasks.update(id, fields) : await tg.tasks.get(id);
  if (checks) await writeChecks(shreni, tg.id, id, checks, true);
  return task;
}

/** Removes a proposed task from the plan. */
export async function deletePlanTask(tg: ProjectHandle, planId: string, id: string): Promise<void> {
  await inPlan(tg, planId, id);
  await tg.as(PLANNER).tasks.delete(id);
}

/**
 * `blocked` waits on `blocker`. The waiting task must be the plan's; the one
 * it waits on is the plan's, or approved work, never another plan's proposal,
 * which would hold this plan's task until that plan is approved.
 */
export async function addPlanDep(tg: ProjectHandle, planId: string, blocked: string, blocker: string): Promise<void> {
  await inPlan(tg, planId, blocked);
  const on = await tg.tasks.get(blocker);
  if (on.planId !== planId && on.state === 'proposed') {
    throw new InvalidRequest(`${blocker} is proposed in ${on.planId ? `plan ${on.planId}` : 'no plan'}; wait only on this plan's tasks or approved work`);
  }
  await tg.as(PLANNER).deps.add(blocked, blocker);
}

export async function removePlanDep(tg: ProjectHandle, planId: string, blocked: string, blocker: string): Promise<void> {
  await inPlan(tg, planId, blocked);
  await tg.as(PLANNER).deps.remove(blocked, blocker);
}

export type PlanSummary = {
  plan: Plan;
  /** Still open: neither approved nor discarded. */
  open: boolean;
  tasks: { task: Task; checks: Check[] }[];
  findings: Finding[];
  /** No error among the findings: approval would go through. */
  ok: boolean;
};

/** The plan, its tasks with their checks, and the validators' findings, as the developer sees it before approving. */
export async function summarisePlan(shreni: ShreniClient, tg: ProjectHandle, as: ActorHandle, planId: string): Promise<PlanSummary> {
  const plan = await tg.plans.get(planId);
  const open = !plan.approvedAt && !plan.discardedAt;
  const tasks = await Promise.all((await tg.tasks.list({ plan: planId, orderBy: 'created' }))
    .map(async task => ({ task, checks: (await checksOf(shreni, tg.id, task.id)).map(({ given, when, then }) => ({ given, when, then })) })));
  const report = open && tasks.length ? await as.plans.validate(planId) : { ok: true, findings: [] as Finding[] };
  return { plan, open, tasks, findings: report.findings, ok: report.ok };
}

/** The plan as lines for a terminal. */
export function renderPlan(s: PlanSummary): string[] {
  const out = [`plan ${s.plan.id}: ${s.plan.title}${s.open ? '' : s.plan.approvedAt ? ' (approved)' : ' (discarded)'}`];
  const depth = (t: Task): number => {
    const parent = s.tasks.find(x => x.task.id === t.parentId);
    return parent ? 1 + depth(parent.task) : 0;
  };
  for (const { task, checks } of s.tasks) {
    const pad = '  '.repeat(1 + depth(task));
    out.push(`${pad}${task.id}  P${task.priority}  ${task.title}${task.kind === 'container' ? '  (epic)' : ''}  [${task.state}]`);
    for (const c of checks) out.push(`${pad}    Given ${c.given}, when ${c.when}, then ${c.then}`);
  }
  if (!s.tasks.length) out.push('  (no tasks filed)');
  for (const f of s.findings) out.push(`  ${f.severity}: ${f.message}`);
  return out;
}

/** What the launcher does with plans, each call on its own connection. */
export interface PlanStore {
  create(title: string, meta?: Record<string, unknown>): Promise<string>;
  summary(planId: string): Promise<PlanSummary>;
  /**
   * Approves the plan, returning the validators' warnings; throws ValidationError
   * on an error, and refuses when its tasks are no longer `shown`.
   */
  approve(planId: string, shown: string[]): Promise<Finding[]>;
  /** Whether the plan exists and is neither approved nor discarded. */
  isOpen(planId: string): Promise<boolean>;
  /** Discards the plan if it is open with no tasks, so an unused plan isn't left for approval. */
  dropIfEmpty(planId: string): Promise<void>;
  /** Cancels every task in the plan. */
  discard(planId: string): Promise<void>;
}

/** The plan store for a Kshetra's project, acting as the developer `user`. */
export function planStore(projectId: string, user: string, open: () => Promise<KshetraEngine>): PlanStore {
  const withDev = async <T>(fn: (s: { shreni: ShreniClient; tg: ProjectHandle; me: ActorHandle }) => Promise<T>): Promise<T> => {
    const conn = await open();
    try {
      const tg = conn.shreni.tg.project(projectId);
      return await fn({ shreni: conn.shreni, tg, me: tg.as({ id: user, role: 'developer' }) });
    } finally {
      await conn.close().catch(() => {});
    }
  };
  return {
    create: (title, meta) => withDev(async ({ me }) => (await me.plans.create({ title, ...(meta ? { meta } : {}) })).id),
    summary: planId => withDev(({ shreni, tg, me }) => summarisePlan(shreni, tg, me, planId)),
    approve: (planId, shown) => withDev(async ({ tg, me }) => {
      // Only what was shown: a session or shell still filing may have grown the plan meanwhile.
      const now = (await tg.tasks.list({ plan: planId })).map(t => t.id).sort().join(',');
      if (now !== [...shown].sort().join(',')) throw new InvalidRequest(`plan ${planId} changed while you looked; look again`);
      return (await me.plans.approve(planId, { via: 'cli' })).findings;
    }),
    isOpen: planId => withDev(async ({ tg }) => {
      const plan = await tg.plans.get(planId).catch(err => {
        if (err instanceof NotFound) return null;
        throw err;
      });
      return !!plan && !plan.approvedAt && !plan.discardedAt;
    }),
    dropIfEmpty: planId => withDev(async ({ tg, me }) => {
      const plan = await tg.plans.get(planId);
      if (plan.approvedAt || plan.discardedAt || (await tg.tasks.count({ plan: planId })) > 0) return;
      await me.plans.discard(planId, { via: 'cli' });
    }),
    discard: planId => withDev(async ({ me }) => { await me.plans.discard(planId, { via: 'cli' }); }),
  };
}
