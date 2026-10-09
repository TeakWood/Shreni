import { sql, type Kysely } from 'kysely';
import type { ActorHandle } from './client';
import { toPlan, type PlanRow } from './reads';
import { lockGraph, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import { textArray } from './sql-values';
import { runValidators, type BuiltinContext, type PlanSnapshot } from './validators';
import { NotFound, type Finding } from './errors';

// Plans (engine spec, "Plans and validation"). A plan is what one planning
// session proposes and a developer approves as a unit; validate is the dry
// run the planner gets before anyone is asked to approve.

export type ValidationReport = { planId: string; ok: boolean; findings: Finding[] };

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
export async function planSnapshot(db: Kysely<any>, projectId: string, planId: string, lock = false): Promise<PlanSnapshot> {
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

export function plansApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;

  return {
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
