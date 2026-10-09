import { sql, type Transaction } from 'kysely';
import type { Finding } from './errors';
import type { Lifecycle } from './lifecycle';
import type { Plan, Task } from './types';

// Validators (engine spec, "Validation"). They run as a dry run in
// plans.validate, so findings reach the planner before a developer sees the
// plan, and again inside approval, where an error refuses it. The engine's
// four built-ins always run; the caller adds its own through openTaskGraph.

export type Dep = { taskId: string; dependsOnId: string };
export type Link = { a: string; b: string; kind: string };
/** A plan, its tasks, and the dependencies and links that touch them. */
export type PlanSnapshot = { plan: Plan; tasks: Task[]; deps: Dep[]; links: Link[] };
export type ValidatorContext = { tx: Transaction<any>; config: unknown };

export interface Validator {
  name: string;
  /** Task scope also runs when a lone task is approved. */
  scope: 'plan' | 'task';
  validate(subject: PlanSnapshot, ctx: ValidatorContext): Promise<Finding[]>;
}

/** What the built-ins also need: the lifecycle, and which ids exist in the project, or have children there. */
export type BuiltinContext = ValidatorContext & {
  lifecycle: Lifecycle;
  /** The given ids that are tasks of the project. */
  exists(ids: string[]): Promise<Set<string>>;
  /** The given ids that have at least one child in the project. */
  withChildren?(ids: string[]): Promise<Set<string>>;
};

type Builtin = Omit<Validator, 'validate'> & { validate(s: PlanSnapshot, ctx: BuiltinContext): Promise<Finding[]> };

const error = (validator: string, message: string, taskId?: string): Finding =>
  ({ validator, severity: 'error', ...(taskId ? { taskId } : {}), message });

/** One dependency cycle among the edges, as the ids along it (first id repeated at the end), or null. */
function findCycle(deps: readonly Dep[]): string[] | null {
  const out = new Map<string, string[]>();
  for (const d of deps) out.set(d.taskId, [...(out.get(d.taskId) ?? []), d.dependsOnId]);
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 'open');
    path.push(n);
    for (const m of out.get(n) ?? []) {
      if (state.get(m) === 'open') return [...path.slice(path.indexOf(m)), m];
      if (!state.has(m)) {
        const found = visit(m);
        if (found) return found;
      }
    }
    path.pop();
    state.set(n, 'done');
    return null;
  };
  for (const n of [...out.keys()].sort()) {
    if (state.has(n)) continue;
    const found = visit(n);
    if (found) return found;
  }
  return null;
}

const noCycles: Builtin = {
  name: 'engine.no-cycles', scope: 'plan',
  async validate(s) {
    const cycle = findCycle(s.deps);
    if (!cycle) return [];
    const inPlan = new Set(s.tasks.map(t => t.id));
    return [error(this.name, `dependencies form a cycle: ${cycle.join(' -> ')}`, cycle.find(id => inPlan.has(id)))];
  },
};

const noMissingRefs: Builtin = {
  name: 'engine.no-missing-refs', scope: 'plan',
  async validate(s, ctx) {
    const inPlan = new Set(s.tasks.map(t => t.id));
    const refs: { id: string; from: string; what: string }[] = [
      ...s.deps.flatMap(d => [{ id: d.dependsOnId, from: d.taskId, what: 'depends on' }, { id: d.taskId, from: d.dependsOnId, what: 'is waited on by' }]),
      ...s.links.flatMap(l => [{ id: l.b, from: l.a, what: `links (${l.kind}) to` }, { id: l.a, from: l.b, what: `is linked (${l.kind}) from` }]),
      ...s.tasks.filter(t => t.parentId).map(t => ({ id: t.parentId!, from: t.id, what: 'sits under' })),
    ].filter(r => !inPlan.has(r.id));
    const outside = [...new Set(refs.map(r => r.id))];
    const found = outside.length ? await ctx.exists(outside) : new Set<string>();
    return refs.filter(r => !found.has(r.id))
      .map(r => error(this.name, `task ${r.from} ${r.what} ${r.id}, which doesn't exist`, inPlan.has(r.from) ? r.from : undefined));
  },
};

const containersHaveChildren: Builtin = {
  name: 'engine.containers-have-children', scope: 'plan',
  async validate(s, ctx) {
    const containers = s.tasks.filter(t => t.kind === 'container');
    if (!containers.length) return [];
    const parents = new Set(s.tasks.map(t => t.parentId).filter(Boolean));
    const lacking = containers.filter(c => !parents.has(c.id)).map(c => c.id);
    const elsewhere = lacking.length && ctx.withChildren ? await ctx.withChildren(lacking) : new Set<string>();
    return lacking.filter(id => !elsewhere.has(id)).map(id => error(this.name, `container ${id} has no children`, id));
  },
};

const preApproval: Builtin = {
  name: 'engine.pre-approval', scope: 'task',
  async validate(s, ctx) {
    const state = ctx.lifecycle.create.state;
    return s.tasks.filter(t => t.state !== state)
      .map(t => error(this.name, `task ${t.id} is ${t.state}, not ${state}: it has already left planning`, t.id));
  },
};

/** The engine's own validators, always run and never turned off. */
export const BUILTIN_VALIDATORS: readonly Builtin[] = [noCycles, noMissingRefs, containersHaveChildren, preApproval];

/** Errors the transaction must see: retried (deadlock, serialization) or raised as Unavailable (the connection). */
function mustPropagate(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? '');
  return code === '40001' || code === '40P01' || code.startsWith('08') || code.startsWith('57P') || code.startsWith('CONNECT');
}

/**
 * Runs the built-ins, then the caller's validators, each inside a savepoint
 * of the caller's transaction, so one that fails in SQL leaves the
 * transaction sound for the next. A validator that throws is an error
 * finding, so it can't let a plan through; deadlocks, serialization failures
 * and a lost connection propagate, for the transaction to retry or report.
 * The caller's validators see only { tx, config }.
 */
export async function runValidators(
  s: PlanSnapshot, ctx: Omit<BuiltinContext, 'config'>, custom: readonly Validator[], configFor: (name: string) => unknown,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const all: { v: Builtin | Validator; builtin: boolean }[] = [
    ...BUILTIN_VALIDATORS.map(v => ({ v, builtin: true })), ...custom.map(v => ({ v, builtin: false })),
  ];
  for (const { v, builtin } of all) {
    const config = configFor(v.name);
    await sql`savepoint taskgraph_validator`.execute(ctx.tx);
    try {
      findings.push(...await (builtin
        ? (v as Builtin).validate(s, { ...ctx, config })
        : (v as Validator).validate(s, { tx: ctx.tx, config })));
      await sql`release savepoint taskgraph_validator`.execute(ctx.tx);
    } catch (err) {
      if (mustPropagate(err)) throw err;
      await sql`rollback to savepoint taskgraph_validator`.execute(ctx.tx);
      findings.push(error(v.name, `validator ${v.name} failed: ${(err as Error)?.message ?? String(err)}`));
    }
  }
  return findings;
}
