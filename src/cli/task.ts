import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { sql } from 'kysely';
import type { CommandContext } from './registry';
import type { ActorHandle, ProjectHandle, Task } from '../taskgraph';
import { loadKshetraConfig } from '../kshetra/config';
import { loadRegistry } from '../kshetra/registry';
import { loadTrackerConfig, type ProjectConfig } from '../kshetra/project-config';
import { loadUserConfig, resolveDatabase } from '../kshetra/user-config';
import { isLocal, pgTools, takeDump, WAIT_MS, type DumpKind } from '../policy/db/backups';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import type { ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import {
  assertHandsOnKshetra, byHandWorker, cancelByHand, checksOf, claimByHand, finishByHand, noteByHand, releaseByHand,
} from '../policy/task/by-hand';
import { NotFound } from '../taskgraph';
import { loadState } from '../kshetra/state';
import { readPid, isAlive } from './pid';
import { createInterface } from 'readline/promises';
import { hostname } from 'os';

// shreni task (policy spec, "Working by hand" and "Project config"): a person,
// or a Claude Code session acting for them, reads and files work with the
// developer role. Each run finds its project from the repo's tracker.yaml or
// kshetra.yaml, and sweeps expired leases before anything else, so a claim that
// lapsed overnight is back in ready by morning. The claim rules are in
// policy/task/by-hand; approve and upgrade need an interactive terminal, which
// a Claude Code shell isn't, so a session can't approve by accident.

export const TASK_SUBCOMMANDS = [
  'ready', 'show', 'list', 'create', 'note', 'remember', 'claim', 'finish', 'release', 'cancel', 'approve', 'upgrade',
] as const;
/** The developer's own calls, refused without an interactive terminal (an accident guard, not a security boundary). */
const TERMINAL_ONLY = new Set(['approve', 'upgrade']);
/** Calls that work a Kshetra's tasks, which its worker owns: by hand only while it is paused (assertHandsOnKshetra). */
const HANDS_ON = new Set(['claim', 'finish', 'release', 'cancel', 'upgrade']);
export const TASK_USAGE = `<${TASK_SUBCOMMANDS.join('|')}> …`;

const HELP = [
  'shreni task ready [--json]                    open tasks with nothing blocking them',
  'shreni task show <id> [--json]                a task, its checks, dependencies and notes',
  'shreni task list [--state <s,…>|--all] [--json]  tasks; every live one by default',
  'shreni task create --title "…" [--description "…"] [--parent <id>] [--priority 0-4] [--epic]',
  '                   [--check "given … when … then …"]…  lands as proposed, for the developer to approve',
  'shreni task note <id> "…"                     a note on a task; renews your claim on it',
  'shreni task remember "…" [--key <key>]        an insight for later sessions',
  'shreni task claim <id>                        take one ready task, yours for 8 hours',
  'shreni task finish <id> --reason "…" [--checks-passed]  finish your task, or complete an epic',
  'shreni task release <id> [--force] [--reason "…"]  give a task back; --force takes back someone else\'s',
  'shreni task cancel <id> --reason "…" [--with-children] [--drop-deps]',
  'shreni task approve <id>                      approve a plan or a lone task (terminal only)',
  'shreni task upgrade [--force]                 move the project to this Shreni\'s lifecycle (terminal only)',
].join('\n');

/** The states a list shows by default: every one not yet terminal. */
const LIVE = ['proposed', 'open', 'claimed', 'waiting', 'blocked', 'parked'];

export interface TaskDeps {
  /** Where the project is looked for, walking up. */
  cwd: string;
  /** SHRENI_KSHETRA, set in a planning session, names the project instead. */
  env: NodeJS.ProcessEnv;
  open(config: ProjectConfig): Promise<KshetraEngine>;
  /** The developer the calls act as: `user` in ~/.shreni/config.yaml, else git's user.email. */
  user(): string | undefined;
  print(line: string): void;
  /** Whether a person is at a terminal: stdin and stdout both a TTY. */
  interactive(): boolean;
  /** Asks a question at the terminal and returns the answer. */
  ask(question: string): Promise<string>;
  /**
   * Dumps the project's database before a change, and waits for it (policy
   * spec, "Backups"); says where, or why none was taken.
   */
  backup(config: ProjectConfig, kind: DumpKind): Promise<string>;
  /** Whether the Kshetra is paused, and its worker on this machine as host/pid (its lock's name), or null. */
  kshetra(id: string): { paused: boolean; localWorker: string | null };
}

const defaultDeps = (): TaskDeps => ({
  cwd: process.cwd(),
  env: process.env,
  open: config => openKshetraEngine(config, { name: 'shreni-task' }),
  user: () => loadUserConfig().user,
  print: line => console.log(line),
  interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  async backup(config, kind) {
    const target = resolveDatabase(config, loadUserConfig());
    // A database on another machine is backed up by whoever runs it.
    if (!isLocal(target)) return `database "${target.name}" isn't on this machine: no dump taken; its owner backs it up`;
    return `dumped first: ${await takeDump(target, kind, pgTools, { wait: WAIT_MS })}`;
  },
  kshetra(id) {
    const pid = readPid(id);
    return { paused: !!loadState().kshetras[id]?.paused, localWorker: pid !== null && isAlive(pid) ? `${hostname()}/${pid}` : null };
  },
});

/** No .shreni/tracker.yaml or kshetra.yaml in or above the directory: not a Shreni repo. */
export class NoProjectConfig extends Error {
  constructor(cwd: string) {
    super(`no .shreni/tracker.yaml or .shreni/kshetra.yaml in ${cwd} or above; run shreni init in the repo`);
    this.name = 'NoProjectConfig';
  }
}

type FoundConfig<C> = { kind: 'tracker' | 'kshetra'; path: string; config: C; kshetraId?: string };

/** The nearest .shreni/tracker.yaml or .shreni/kshetra.yaml above `cwd`, registered with a project or not. */
export function findConfigFile(cwd: string): FoundConfig<ProjectConfig> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const tracker = join(dir, '.shreni', 'tracker.yaml');
    const kshetra = join(dir, '.shreni', 'kshetra.yaml');
    const found = [existsSync(tracker) && tracker, existsSync(kshetra) && kshetra].filter((p): p is string => !!p);
    if (found.length > 1) throw new Error(`${dir} has both .shreni/tracker.yaml and .shreni/kshetra.yaml; a repo is one or the other`);
    if (found.length === 1) {
      const kind = found[0] === tracker ? 'tracker' : 'kshetra';
      const kshetraConfig = kind === 'kshetra' ? loadKshetraConfig(found[0]) : undefined;
      const config: ProjectConfig = kshetraConfig ?? loadTrackerConfig(found[0]);
      return { kind, path: found[0], config, ...(kshetraConfig ? { kshetraId: kshetraConfig.id } : {}) };
    }
    // A repo's own root ends the walk, so a clone nested in a tracked repo never acts on the outer project.
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) throw new NoProjectConfig(resolve(cwd));
  }
}

/** The repo's project config, from the nearest .shreni/tracker.yaml or .shreni/kshetra.yaml above `cwd`; it must name its project. */
export function findProjectConfig(cwd: string): FoundConfig<ProjectConfig & { project: string }> {
  const found = findConfigFile(cwd);
  if (!found.config.project) throw new Error(`${found.path} names no project yet; run shreni init`);
  return found as FoundConfig<ProjectConfig & { project: string }>;
}

/**
 * The project a command works on: the Kshetra a planning session was launched
 * for (SHRENI_KSHETRA, since its worktree may not carry the config), else the
 * repo's own config found from `cwd`. With requireProject false, a config that
 * init hasn't registered yet is returned too, for what it names (its database).
 */
export function resolveProject(cwd: string, env: NodeJS.ProcessEnv): FoundConfig<ProjectConfig & { project: string }>;
export function resolveProject(cwd: string, env: NodeJS.ProcessEnv, opts: { requireProject: false }): FoundConfig<ProjectConfig>;
export function resolveProject(cwd: string, env: NodeJS.ProcessEnv, opts: { requireProject?: boolean } = {}): FoundConfig<ProjectConfig> {
  const id = env.SHRENI_KSHETRA;
  if (!id) return opts.requireProject === false ? findConfigFile(cwd) : findProjectConfig(cwd);
  const k = loadRegistry().find(x => x.id === id);
  if (!k) throw new Error(`SHRENI_KSHETRA names Kshetra ${id}, which isn't registered`);
  if (!k.project && opts.requireProject !== false) throw new Error(`Kshetra ${id} isn't on the task graph engine`);
  return { kind: 'kshetra', path: `registry:${id}`, config: k, kshetraId: k.id };
}

/** One acceptance check from "given … when … then …". */
export function parseCheck(text: string): { given: string; when: string; then: string } {
  const m = /^\s*given\b:?(.*?)\bwhen\b:?(.*?)\bthen\b:?(.*)$/is.exec(text);
  // Each clause loses the punctuation around it, and must say something.
  const clause = (c: string | undefined) => (c ?? '').trim().replace(/^[\s,;:.]+|[\s,;:.]+$/g, '');
  const [given, when, then] = [clause(m?.[1]), clause(m?.[2]), clause(m?.[3])];
  if (!m || !/\w/.test(given) || !/\w/.test(when) || !/\w/.test(then)) {
    throw new Error(`a check reads "given … when … then …", each part saying something: ${JSON.stringify(text)}`);
  }
  return { given, when, then };
}

/** A subcommand's arguments, read strictly: an unknown flag, a missing value or a stray word is refused. */
export function parseArgs(
  args: string[], spec: { valued?: string[]; repeated?: string[]; bool?: string[]; positionals?: number | 'rest'; command?: string },
): { values: Record<string, string>; repeated: Record<string, string[]>; bools: Set<string>; positionals: string[] } {
  const valued = new Set([...(spec.valued ?? []), ...(spec.repeated ?? [])]);
  const bool = new Set([...(spec.bool ?? []), '--json']);
  const out = { values: {} as Record<string, string>, repeated: {} as Record<string, string[]>, bools: new Set<string>(), positionals: [] as string[] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (a.includes('=')) throw new Error(`write ${a.slice(0, a.indexOf('='))} <value>, not ${a}`);
      if (bool.has(a)) { out.bools.add(a); continue; }
      if (!valued.has(a)) throw new Error(`${spec.command ?? `shreni task ${args[0]}`} takes no ${a}`);
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (spec.repeated?.includes(a)) (out.repeated[a] ??= []).push(v);
      else if (a in out.values) throw new Error(`${a} is given twice`);
      else out.values[a] = v;
      continue;
    }
    out.positionals.push(a);
  }
  const max = spec.positionals ?? 0;
  if (max !== 'rest' && out.positionals.length > max) {
    throw new Error(`unexpected ${JSON.stringify(out.positionals[max])}; quote a value that has spaces`);
  }
  return out;
}

/** A memory's key from its first words, as bd remember made one. */
export function memoryKey(content: string): string {
  // The content's hash keeps two insights that start alike, or have no ASCII words, apart.
  const slug = content.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 6);
  return slug ? `${slug}-${hash}` : `memory-${hash}`;
}

const line = (t: Task) =>
  `${t.id}  P${t.priority}  ${t.title}${t.kind === 'container' ? '  (epic)' : ''}  [${t.state}]`;

export async function runTask(ctx: CommandContext, overrides: Partial<TaskDeps> = {}): Promise<void> {
  const deps: TaskDeps = { ...defaultDeps(), ...overrides };
  const sub = ctx.args[0];
  if (!sub || sub === 'help' || ctx.has('--help')) {
    deps.print(HELP);
    return;
  }
  if (!(TASK_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(`unknown shreni task command ${JSON.stringify(sub)}; it takes ${TASK_SUBCOMMANDS.join(', ')}`);
  }
  if (TERMINAL_ONLY.has(sub) && !deps.interactive()) {
    throw new Error(`shreni task ${sub} is the developer's, and needs an interactive terminal`);
  }
  const found = resolveProject(deps.cwd, deps.env);
  const { config } = found;
  const user = deps.user();
  if (!user) throw new Error('no developer to act as: set user in ~/.shreni/config.yaml, or git config user.email');

  const conn = await deps.open(config);
  try {
    const tg = conn.shreni.tg.project(config.project);
    await tg.expireLeases();
    const me = tg.as({ id: user, role: 'developer' });
    if (found.kshetraId && HANDS_ON.has(sub)) {
      const k = deps.kshetra(found.kshetraId);
      assertHandsOnKshetra({
        call: sub, kshetraId: found.kshetraId, interactive: deps.interactive(), paused: k.paused,
        lockHolder: await tg.locks.holder('worker'), localWorker: k.localWorker,
      });
    }
    await SUBCOMMANDS[sub as (typeof TASK_SUBCOMMANDS)[number]]({ ctx, deps, tg, me, shreni: conn.shreni, found, user });
  } finally {
    await conn.close().catch(() => {});
  }
}

type Run = (s: {
  ctx: CommandContext; deps: TaskDeps; tg: ProjectHandle; me: ActorHandle; shreni: ShreniClient;
  found: ReturnType<typeof findProjectConfig>; user: string;
}) => Promise<void>;

/** The one task id a subcommand takes. */
function oneId(a: { positionals: string[] }, usage: string): string {
  const [id] = a.positionals;
  if (!id) throw new Error(`Usage: shreni task ${usage}`);
  return id;
}

const SUBCOMMANDS: Record<(typeof TASK_SUBCOMMANDS)[number], Run> = {
  async ready({ ctx, deps, tg }) {
    const json = parseArgs(ctx.args, {}).bools.has('--json');
    const tasks = await tg.ready({ kind: 'work' });
    if (json) return deps.print(JSON.stringify(tasks));
    deps.print(tasks.length ? tasks.map(line).join('\n') : 'nothing is ready');
  },

  async list({ ctx, deps, tg }) {
    const a = parseArgs(ctx.args, { valued: ['--state'], bool: ['--all'] });
    const json = a.bools.has('--json');
    const state = a.values['--state'];
    if (state !== undefined && a.bools.has('--all')) throw new Error('give --state or --all, not both');
    const states = state?.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = states?.filter(s => !Object.hasOwn(taskLifecycle.states, s)) ?? [];
    if (unknown.length || states?.length === 0) {
      throw new Error(`no state ${JSON.stringify(unknown[0] ?? state)}; the states are ${Object.keys(taskLifecycle.states).join(', ')}`);
    }
    const tasks = await tg.tasks.list({ ...(a.bools.has('--all') ? {} : { states: states ?? LIVE }), orderBy: 'created' });
    if (json) return deps.print(JSON.stringify(tasks));
    deps.print(tasks.length ? tasks.map(line).join('\n') : 'no tasks');
  },

  async show({ ctx, deps, tg, shreni }) {
    const a = parseArgs(ctx.args, { positionals: 1 });
    const json = a.bools.has('--json');
    const [id] = a.positionals;
    if (!id) throw new Error('Usage: shreni task show <id>');
    const task = await tg.tasks.get(id);
    const checks = await shreni.db.selectFrom('shreni.acceptance_checks').select(['given', 'when', 'then', 'mode'])
      .where('project_id', '=', tg.id).where('task_id', '=', id).orderBy('created_at').orderBy('id').execute();
    const notes = (await tg.tasks.history(id))
      .filter(e => e.kind === 'note' || (e.kind.startsWith('move:') && typeof e.payload?.reason === 'string'))
      .map(e => ({ at: e.at, actor: e.actor, text: String(e.kind === 'note' ? e.payload?.text : `${e.kind.slice(5)}: ${e.payload?.reason}`) }));
    if (json) return deps.print(JSON.stringify({ ...task, checks, notes }));
    const out = [
      `${task.id}  ${task.title}${task.kind === 'container' ? '  (epic)' : ''}`,
      `state ${task.state} · P${task.priority}${task.parentId ? ` · under ${task.parentId}` : ''}${task.tags.length ? ` · ${task.tags.join(', ')}` : ''}`,
    ];
    if (task.claim) out.push(`claimed by ${task.claim.actor} (${task.claim.worker}) until ${new Date(task.claim.expiresAt).toISOString()}`);
    if (task.description) out.push('', task.description);
    if (checks.length) {
      out.push('', 'Acceptance checks:');
      for (const c of checks) out.push(`  - Given ${c.given}, when ${c.when}, then ${c.then}${c.mode === 'manual' ? ' (manual)' : ''}`);
    }
    if (task.deps.length) {
      out.push('', 'depends on:');
      for (const d of task.deps) out.push(`  ${d.id}  [${d.state}]`);
    }
    if (notes.length) {
      out.push('', 'Notes:');
      for (const n of notes) out.push(`  ${new Date(n.at).toISOString()}  ${n.actor}: ${n.text}`);
    }
    deps.print(out.join('\n'));
  },

  async create({ ctx, deps, me, tg, shreni }) {
    const a = parseArgs(ctx.args, { valued: ['--title', '--description', '--parent', '--priority'], repeated: ['--check'], bool: ['--epic'] });
    const json = a.bools.has('--json');
    const { '--title': title, '--description': description, '--parent': parent, '--priority': priority } = a.values;
    if (!title?.trim()) throw new Error('Usage: shreni task create --title "…" [--check "given … when … then …"]…');
    // Every check is read before anything is filed, so a malformed one files nothing.
    const checks = (a.repeated['--check'] ?? []).map(parseCheck);
    // An epic finishes when its children settle; checks on it would never be run.
    if (checks.length && a.bools.has('--epic')) throw new Error('an epic takes no --check; give its tasks the checks');
    if (priority !== undefined && !/^[0-4]$/.test(priority)) throw new Error('--priority takes 0 to 4');
    const task = await me.tasks.create({
      title,
      ...(description ? { description } : {}),
      ...(parent ? { parent } : {}),
      ...(priority !== undefined ? { priority: Number(priority) } : {}),
      ...(a.bools.has('--epic') ? { kind: 'container' as const } : {}),
    });
    if (checks.length) {
      try {
        await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
          // One transaction shares one now(), so each check is a microsecond on, to read back in order.
          .values(checks.map((c, i) => ({
            project_id: tg.id, task_id: task.id, ...c, mode: 'auto',
            created_at: sql<Date>`now() + ${i} * interval '1 microsecond'`,
          })))
          .execute());
      } catch (err) {
        // The engine's create can't join Shreni's transaction, so a task whose
        // checks failed to land is removed rather than left without them.
        try {
          await me.tasks.delete(task.id);
        } catch (gone) {
          throw new Error(
            `filed ${task.id}, but its checks failed (${(err as Error).message}) and it could not be removed ` +
              `(${(gone as Error).message}); delete it, or file its checks again`,
          );
        }
        throw err;
      }
    }
    if (json) return deps.print(JSON.stringify({ ...task, checks }));
    deps.print(`filed ${task.id} (${task.state}): ${task.title}${checks.length ? ` · ${checks.length} check${checks.length > 1 ? 's' : ''}` : ''}`);
  },

  async note({ ctx, deps, me }) {
    const [id, ...words] = parseArgs(ctx.args, { positionals: 'rest' }).positionals;
    const text = words.join(' ').trim();
    if (!id || !text) throw new Error('Usage: shreni task note <id> "…"');
    await noteByHand(me, id, text);
    deps.print(`noted on ${id}`);
  },

  async remember({ ctx, deps, tg, shreni }) {
    const a = parseArgs(ctx.args, { valued: ['--key'], positionals: 'rest' });
    const content = a.positionals.join(' ').trim();
    if (!content) throw new Error('Usage: shreni task remember "…" [--key <key>]');
    const given = a.values['--key']?.trim();
    if (given === '') throw new Error('--key needs a value');
    const key = given ?? memoryKey(content);
    // xmax is set on a row the upsert updated, so the output can say it replaced one.
    const r = await shreni.transaction(db => sql<{ replaced: boolean }>`
      insert into shreni.memories (project_id, key, content) values (${tg.id}, ${key}, ${content})
      on conflict (project_id, key) do update set content = excluded.content, updated_at = now()
      returning (xmax <> 0) as replaced`.execute(db));
    deps.print(`${r.rows[0]?.replaced ? 'replaced' : 'remembered'} ${key}`);
  },

  async claim({ ctx, deps, tg, me, user }) {
    const id = oneId(parseArgs(ctx.args, { positionals: 1 }), 'claim <id>');
    const claim = await claimByHand(tg, me, id, { worker: byHandWorker(user) });
    deps.print(`claimed ${id} until ${new Date(claim.expiresAt).toISOString()}: ${claim.task.title}`);
  },

  async finish({ ctx, deps, tg, me, shreni }) {
    const a = parseArgs(ctx.args, { valued: ['--reason'], bool: ['--checks-passed'], positionals: 1 });
    const id = oneId(a, 'finish <id> --reason "…"');
    const reason = a.values['--reason']?.trim();
    if (!reason) throw new Error('Usage: shreni task finish <id> --reason "…"');
    await finishByHand(shreni, tg, me, id, { reason, checksPassed: a.bools.has('--checks-passed') });
    deps.print(`finished ${id}`);
  },

  async release({ ctx, deps, me }) {
    const a = parseArgs(ctx.args, { valued: ['--reason'], bool: ['--force'], positionals: 1 });
    const id = oneId(a, 'release <id> [--force]');
    await releaseByHand(me, id, { force: a.bools.has('--force'), ...(a.values['--reason'] ? { reason: a.values['--reason'] } : {}) });
    deps.print(`released ${id}`);
  },

  async cancel({ ctx, deps, tg, me, shreni }) {
    const a = parseArgs(ctx.args, { valued: ['--reason'], bool: ['--with-children', '--drop-deps'], positionals: 1 });
    const id = oneId(a, 'cancel <id> --reason "…"');
    const reason = a.values['--reason']?.trim();
    if (!reason) throw new Error('Usage: shreni task cancel <id> --reason "…" [--with-children] [--drop-deps]');
    const done = await cancelByHand(shreni, tg, me, id, {
      reason, withChildren: a.bools.has('--with-children'), dropDeps: a.bools.has('--drop-deps'),
    });
    deps.print(`cancelled ${done.join(', ')}`);
  },

  async approve({ ctx, deps, tg, me, shreni }) {
    const id = oneId(parseArgs(ctx.args, { positionals: 1 }), 'approve <id>');
    const plan = await tg.plans.get(id).catch(err => {
      if (err instanceof NotFound) return null;
      throw err;
    });
    // What is approved is shown first, checks included: the tasks, and the validators' findings.
    const shown = async (t: Task) => [
      `  ${line(t)}`,
      ...(await checksOf(shreni, tg.id, t.id)).map(c => `      Given ${c.given}, when ${c.when}, then ${c.then}${c.mode === 'manual' ? ' (manual)' : ''}`),
    ];
    const planTasks = () => tg.tasks.list({ plan: id, orderBy: 'created' });
    const before = plan ? await planTasks() : [await tg.tasks.get(id)];
    const out = [plan ? `plan ${id}: ${plan.title}` : 'task'];
    for (const t of before) out.push(...await shown(t));
    if (plan) {
      const report = await me.plans.validate(id);
      for (const f of report.findings) out.push(`  ${f.severity}: ${f.message}`);
      deps.print(out.join('\n'));
      if (!report.ok) throw new Error(`plan ${id} doesn't pass validation; fix the errors above first`);
    } else {
      deps.print(out.join('\n'));
    }
    // The id typed back: approving is the step that makes work runnable.
    if ((await deps.ask(`Type ${id} to approve it: `)).trim() !== id) throw new Error('not approved');
    if (plan) {
      // Approve only what was shown: a plan still being filed may have grown meanwhile.
      const now = (await planTasks()).map(t => t.id).sort().join(',');
      if (now !== before.map(t => t.id).sort().join(',')) throw new Error(`plan ${id} changed while you looked; run approve again`);
      for (const f of (await me.plans.approve(id, { via: 'cli' })).findings) deps.print(`  ${f.severity}: ${f.message}`);
    } else {
      await me.tasks.approve(id, { via: 'cli' });
    }
    deps.print(`approved ${id}`);
  },

  async upgrade({ ctx, deps, tg, me, shreni, found }) {
    const a = parseArgs(ctx.args, { bool: ['--force'] });
    const force = a.bools.has('--force');
    const { version, name } = shreni.tg.lifecycle;
    const diff = await tg.lifecycles.diff(version);
    if (diff.from.version === version) return deps.print(`already on ${name}@${version}`);
    if (diff.from.version > version) {
      throw new Error(`the project is on ${diff.from.name}@${diff.from.version}, newer than this Shreni's ${name}@${version}; upgrade Shreni instead`);
    }
    const list = (label: string, xs: string[]) => (xs.length ? [`  ${label}: ${xs.join(', ')}`] : []);
    const flags = (f: Record<string, true>) => Object.keys(f).join(',') || 'none';
    deps.print([
      `${diff.from.name}@${diff.from.version} → ${name}@${version}`,
      ...list('states added', diff.states.added), ...list('states removed', diff.states.removed),
      ...diff.flags.map(f => `  state ${f.state}: ${flags(f.from)} → ${flags(f.to)}`),
      ...list('moves added', diff.moves.added), ...list('moves removed', diff.moves.removed),
      ...list('moves changed', diff.changedMoves),
      ...diff.roles.map(r => `  ${r.move} roles: +${r.added.join(',') || '-'} -${r.removed.join(',') || '-'}`),
      ...diff.guards.map(g => `  ${g.move} guard: ${g.from ?? 'none'} → ${g.to ?? 'none'}`),
      ...list('hooks changed', diff.hooks), ...list('permissions changed', diff.permissions),
      ...(diff.create ? ['  the create rules change'] : []),
      ...diff.tasks.map(t => `  ${t.id}: ${t.from} → ${t.to}`),
      ...diff.leases.map(l => `  lease on ${l.taskId} (worker ${l.worker})${l.live ? ', live' : ''}`),
    ].join('\n'));
    // What activation would refuse is refused before asking.
    const blockers = [
      ...diff.unmapped.map(u => `no state ${u.state} for ${u.tasks.join(', ')}`),
      ...diff.broken,
      ...(force ? [] : diff.leases.filter(l => l.live).map(l => `a live lease on ${l.taskId} (worker ${l.worker}); wait for it, or pass --force to end it`)),
    ];
    if (blockers.length) throw new Error(`can't upgrade:\n${blockers.map(b => `  - ${b}`).join('\n')}`);
    const target = `${name}@${version}`;
    if ((await deps.ask(`Type ${target} to upgrade: `)).trim() !== target) throw new Error('not upgraded');
    // An upgrade can move real tasks, so a dump comes first, and the upgrade waits for it.
    deps.print(await deps.backup(found.config, 'pre-upgrade'));
    await me.lifecycles.activate(version, { force });
    deps.print(`upgraded to ${target}`);
  },
};
