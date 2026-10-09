import type { CommandContext } from './registry';
import { parseArgs, parseCheck, resolveProject } from './task';
import type { ProjectConfig } from '../kshetra/project-config';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import {
  addPlanDep, addPlanTask, deletePlanTask, PLAN_ENV, PLANNER, removePlanDep, renderPlan, summarisePlan, updatePlanTask,
} from '../policy/suthradhara/filing';

// shreni plan (policy spec, "Approval: humans only"): what a planning session
// files with. It works only on the plan its session was launched for
// (SHRENI_PLAN), with the planner role, so every task lands proposed in that
// plan; approving it is the developer's, in the launcher or shreni task approve.

export const PLAN_USAGE = '<task add|task update|task delete|dep add|dep remove|validate|show> …';

const HELP = [
  'shreni plan task add --title "…" [--description "…"] [--parent <id>] [--priority 0-4] [--epic] [--category <c>]',
  '                     [--check "given … when … then …"]…   prints the new task\'s id',
  'shreni plan task update <id> [--title "…"] [--description "…"] [--priority 0-4] [--check "…"]…   --check replaces its checks',
  'shreni plan task delete <id>',
  'shreni plan dep add <task> <depends-on>        the first waits on the second',
  'shreni plan dep remove <task> <depends-on>',
  'shreni plan validate                           the validators\' findings; fails on an error',
  'shreni plan show                               the plan, its tasks and checks',
  `Every command works on the plan in $${PLAN_ENV}.`,
].join('\n');

export interface PlanDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  open(config: ProjectConfig): Promise<KshetraEngine>;
  print(line: string): void;
}

const defaultDeps = (): PlanDeps => ({
  cwd: process.cwd(),
  env: process.env,
  open: config => openKshetraEngine(config, { name: 'shreni-plan' }),
  print: line => console.log(line),
});


const priorityOf = (v: string | undefined) => {
  if (v === undefined) return undefined;
  if (!/^[0-4]$/.test(v)) throw new Error('--priority takes 0 to 4');
  return Number(v);
};

export async function runPlan(ctx: CommandContext, overrides: Partial<PlanDeps> = {}): Promise<void> {
  const deps: PlanDeps = { ...defaultDeps(), ...overrides };
  const [noun, verb] = ctx.args;
  const cmd = ['validate', 'show'].includes(noun) ? noun : `${noun} ${verb}`;
  const known = ['task add', 'task update', 'task delete', 'dep add', 'dep remove', 'validate', 'show'];
  if (!noun || noun === 'help' || ctx.has('--help')) return deps.print(HELP);
  if (!known.includes(cmd)) throw new Error(`unknown shreni plan command ${JSON.stringify(cmd)}; it takes ${known.join(', ')}`);
  const planId = deps.env[PLAN_ENV];
  if (!planId) throw new Error(`shreni plan works on the plan in $${PLAN_ENV}, which isn't set: it runs inside a planning session`);
  // The words after the command, as parseArgs reads them (it skips the first).
  const rest = cmd.includes(' ') ? ctx.args.slice(1) : ctx.args;
  const command = `shreni plan ${cmd}`;

  const { config } = resolveProject(deps.cwd, deps.env);
  const conn = await deps.open(config);
  try {
    const { shreni } = conn;
    const tg = shreni.tg.project(config.project);
    switch (cmd) {
      case 'task add': {
        const a = parseArgs(rest, {
          command, valued: ['--title', '--description', '--parent', '--priority', '--category'], repeated: ['--check'], bool: ['--epic'],
        });
        const title = a.values['--title']?.trim();
        if (!title) throw new Error('Usage: shreni plan task add --title "…"');
        const checks = (a.repeated['--check'] ?? []).map(parseCheck);
        const task = await addPlanTask(shreni, tg, planId, {
          title, checks, epic: a.bools.has('--epic'), priority: priorityOf(a.values['--priority']),
          description: a.values['--description'], parent: a.values['--parent'], category: a.values['--category'],
        });
        deps.print(a.bools.has('--json') ? JSON.stringify({ ...task, checks }) : task.id);
        break;
      }
      case 'task update': {
        const a = parseArgs(rest, { command, valued: ['--title', '--description', '--priority'], repeated: ['--check'], positionals: 1 });
        const [id] = a.positionals;
        if (!id) throw new Error('Usage: shreni plan task update <id> …');
        const checks = a.repeated['--check']?.map(parseCheck);
        await updatePlanTask(shreni, tg, planId, id, {
          ...(a.values['--title'] ? { title: a.values['--title'] } : {}),
          ...(a.values['--description'] !== undefined ? { description: a.values['--description'] } : {}),
          ...(a.values['--priority'] !== undefined ? { priority: priorityOf(a.values['--priority']) } : {}),
          ...(checks ? { checks } : {}),
        });
        deps.print(`updated ${id}`);
        break;
      }
      case 'task delete': {
        const [id] = parseArgs(rest, { command, positionals: 1 }).positionals;
        if (!id) throw new Error('Usage: shreni plan task delete <id>');
        await deletePlanTask(tg, planId, id);
        deps.print(`deleted ${id}`);
        break;
      }
      case 'dep add':
      case 'dep remove': {
        const [blocked, blocker] = parseArgs(rest, { command, positionals: 2 }).positionals;
        if (!blocked || !blocker) throw new Error(`Usage: ${command} <task> <depends-on>`);
        await (cmd === 'dep add' ? addPlanDep : removePlanDep)(tg, planId, blocked, blocker);
        deps.print(`${blocked} ${cmd === 'dep add' ? 'waits on' : 'no longer waits on'} ${blocker}`);
        break;
      }
      case 'validate':
      case 'show': {
        parseArgs(rest, { command });
        const summary = await summarisePlan(shreni, tg, tg.as(PLANNER), planId);
        if (cmd === 'show') {
          deps.print(renderPlan(summary).join('\n'));
          break;
        }
        for (const f of summary.findings) deps.print(`${f.severity}: ${f.taskId ? `${f.taskId}: ` : ''}${f.message}`);
        if (!summary.ok) throw new Error(`plan ${planId} has errors; fix them before the session ends`);
        deps.print(summary.findings.length ? `plan ${planId} passes, with warnings` : `plan ${planId} passes`);
        break;
      }
    }
  } finally {
    await conn.close().catch(() => {});
  }
}
