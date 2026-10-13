import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { sql } from 'kysely';
import type { CommandContext } from './registry';
import type { ActorHandle, ProjectHandle, Task, TaskPatch } from '../taskgraph';
import { loadKshetraConfig, NotMigratedError } from '../kshetra/config';
import { loadRegistry } from '../kshetra/registry';
import { loadTrackerConfig, type ProjectConfig } from '../kshetra/project-config';
import { loadUserConfig, resolveDatabase } from '../kshetra/user-config';
import { isLocal, pgTools, takeDump, WAIT_MS, type DumpKind } from '../policy/db/backups';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import type { ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import {
  assertHandsOnKshetra, byHandWorker, cancelByHand, checksOf, claimByHand, confirmable, confirmByHand, finishByHand, noteByHand, releaseByHand,
} from '../policy/task/by-hand';
import { InvalidRequest, NotFound, VersionMismatch } from '../taskgraph';
import { loadState } from '../kshetra/state';
import { blockBody, blockProblem, installPrimeHooks, leftoverWarning, writeBlock } from '../policy/init/instructions';
import { PROVIDER_REGISTRY, providerFromCliName, providerInstructionFile } from '../agents/providers/registry';
import type { Provider } from '../agents/providers/types';
import type { KshetraConfig } from '../kshetra/config';
import type { TrackerConfig } from '../kshetra/project-config';
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
  'ready', 'show', 'list', 'create', 'edit', 'note', 'remember', 'claim', 'finish', 'release', 'cancel', 'approve', 'confirm', 'unblock', 'upgrade',
  'setup', 'prime',
] as const;
/** The developer's own calls, refused without an interactive terminal (an accident guard, not a security boundary). */
const TERMINAL_ONLY = new Set(['approve', 'confirm', 'unblock', 'upgrade']);
/** Calls that work a Kshetra's tasks, which its worker owns: by hand only while it is paused (assertHandsOnKshetra). */
const HANDS_ON = new Set(['claim', 'finish', 'release', 'cancel', 'edit', 'upgrade']);
export const TASK_USAGE = `<${TASK_SUBCOMMANDS.join('|')}> …`;

const HELP = [
  'shreni task ready [--json]                    open tasks with nothing blocking them',
  'shreni task show <id> [--json]                a task, its checks, dependencies and notes',
  'shreni task list [--state <s,…>|--all] [--json]  tasks; every live one by default',
  'shreni task create --title "…" [--description "…"] [--parent <id>] [--priority 0-4] [--epic]',
  '                   [--check "given … when … then …"]…  lands as proposed, for the developer to approve',
  'shreni task edit <id> [--title "…"] [--description "…"] [--priority 0-4] [--parent <id>|--no-parent]',
  '                 [--check "given … when … then …"]… [--clear-checks]  correct a task not yet finished, keeping its id',
  'shreni task note <id> "…"                     a note on a task; renews your claim on it',
  'shreni task remember "…" [--key <key>]        an insight for later sessions',
  'shreni task claim <id>                        take one ready task, yours for 8 hours',
  'shreni task finish <id> --reason "…" [--checks-passed]  finish your task, or complete an epic',
  'shreni task release <id> [--force] [--reason "…"]  give a task back; --force takes back someone else\'s',
  'shreni task cancel <id> --reason "…" [--with-children] [--drop-deps]',
  'shreni task approve <id>                      approve a plan, an epic with its tasks, or a lone task (terminal only)',
  'shreni task confirm <id> [--reason "…"]        confirm a flagged task\'s acceptance checks hold, and finish it (terminal only)',
  'shreni task unblock <id> --reason "…"         give a blocked task back to open, once its cause is dealt with (terminal only)',
  'shreni task upgrade [--force]                 move the project to this Shreni\'s lifecycle (terminal only)',
  'shreni task setup                             rewrite Shreni\'s block in the repo\'s instruction files, and the prime hooks',
  'shreni task prime                             the block\'s rules and the project\'s memories, for an agent session',
].join('\n');

/** The states a list shows by default: every one not yet terminal. */
const LIVE = ['proposed', 'open', 'claimed', 'waiting', 'blocked', 'parked'];
/** The states the developer may edit a task in: the lifecycle's tasks.update permission. */
const updatable = taskLifecycle.permissions['tasks.update']?.developer;
const EDITABLE: string[] = updatable === true ? Object.keys(taskLifecycle.states) : (updatable ?? []);
const EDIT_USAGE = 'edit <id> [--title "…"] [--description "…"] [--priority 0-4] [--parent <id>|--no-parent] [--check "…"]… [--clear-checks]';

export interface TaskDeps {
  /** Where the project is looked for, walking up. */
  cwd: string;
  /** SHRENI_KSHETRA, set in a planning session, names the project instead. */
  env: NodeJS.ProcessEnv;
  open(config: ProjectConfig, opts?: { connectTimeout?: number }): Promise<KshetraEngine>;
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
  /** Whether output is colored. */
  color: boolean;
}

/** Color for a terminal only: never with NO_COLOR set (no-color.org), nor on a dumb one. */
export function colorOn(stdoutTTY: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return !!stdoutTTY && !env.NO_COLOR && env.TERM !== 'dumb';
}

const defaultDeps = (): TaskDeps => ({
  cwd: process.cwd(),
  env: process.env,
  open: (config, opts) => openKshetraEngine(config, { name: 'shreni-task', ...opts }),
  user: () => loadUserConfig().user,
  print: line => console.log(line),
  color: colorOn(process.stdout.isTTY, process.env),
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
  if (!k.project && opts.requireProject !== false) throw new NotMigratedError(id);
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

// ANSI SGR colors for list's tree.
const ID_COLOR = 36;
const TITLE_COLOR = 37;
const STATE_COLORS: Record<string, number> = { proposed: 35, open: 32, claimed: 33, waiting: 34, blocked: 31 };
/** A state's color: parked, done, cancelled and any other are gray. */
export const stateColor = (state: string): number => STATE_COLORS[state] ?? 90;

// Tasks filed in one transaction share a created time; their ids then keep
// the filing order, compared by number (web-ab.2 before web-ab.10).
const byId = new Intl.Collator('en', { numeric: true });
const created = (a: Task, b: Task) => +a.createdAt - +b.createdAt || byId.compare(a.id, b.id);

// A title is one line of text: a newline or an escape code in it would break the tree.
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/**
 * The tasks as a tree, one per line as `<id> [<state>]: <title>`, children
 * under their parent with ├── / └── / │, in created order. A task whose
 * parent isn't among them stands at the top level.
 */
function treeLines(tasks: Task[], color: boolean): string[] {
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const ids = new Set(tasks.map(t => t.id));
  const children = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of [...tasks].sort(created)) {
    if (!t.parentId || !ids.has(t.parentId)) roots.push(t);
    else if (children.has(t.parentId)) children.get(t.parentId)!.push(t);
    else children.set(t.parentId, [t]);
  }
  const out: string[] = [];
  const draw = (t: Task, lead: string, branch: string, next: string): void => {
    out.push(`${lead}${branch}${paint(ID_COLOR, t.id)} ${paint(stateColor(t.state), `[${t.state}]`)}: ${paint(TITLE_COLOR, oneLine(t.title))}`);
    const kids = children.get(t.id) ?? [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      draw(k, lead + next, last ? '└── ' : '├── ', last ? '    ' : '│   ');
    });
  };
  for (const r of roots) draw(r, '', '', '');
  return out;
}

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
  // The instruction files are the repo's, not the database's.
  if (sub === 'setup') return setup(ctx, deps);
  if (sub === 'prime') return prime(ctx, deps);
  const found = resolveProject(deps.cwd, deps.env);
  const { config } = found;
  const user = deps.user();
  if (!user) throw new Error('no developer to act as: set user in ~/.shreni/config.yaml, or git config user.email');

  const conn = await deps.open(config);
  try {
    const tg = conn.shreni.tg.project(config.project);
    // The sweep writes, which a project on an older lifecycle refuses; upgrade is how it moves on.
    if (sub !== 'upgrade') {
      try {
        await tg.expireLeases();
      } catch (err) {
        if (!(err instanceof VersionMismatch)) throw err;
        throw new Error(`${err.message}; run shreni task upgrade in a terminal`);
      }
    }
    const me = tg.as({ id: user, role: 'developer' });
    if (found.kshetraId && HANDS_ON.has(sub)) {
      const k = deps.kshetra(found.kshetraId);
      assertHandsOnKshetra({
        call: sub, kshetraId: found.kshetraId, interactive: deps.interactive(), paused: k.paused,
        lockHolder: await tg.locks.holder('worker'), localWorker: k.localWorker,
      });
    }
    await SUBCOMMANDS[sub as keyof typeof SUBCOMMANDS]({ ctx, deps, tg, me, shreni: conn.shreni, found, user });
  } finally {
    await conn.close().catch(() => {});
  }
}

/** The task's local branches (bead-<id>/<slug>) in the repo; none when git can't say. */
function leftBranches(repo: string, id: string): string[] {
  try {
    return execFileSync('git', ['-C', repo, 'branch', '--list', `bead-${id}/*`, '--format=%(refname:short)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Moves a project to this Shreni's lifecycle version (policy spec, "Lifecycle
 * upgrades in practice"): shows what changes, refuses what activation would,
 * asks for the version typed back, dumps first, then activates. Used by
 * shreni task upgrade and by shreni start.
 */
export async function upgradeProject(o: {
  tg: ProjectHandle; me: ActorHandle; shreni: ShreniClient; config: ProjectConfig;
  deps: Pick<TaskDeps, 'print' | 'ask' | 'backup'>; force?: boolean;
}): Promise<void> {
  const { tg, me, shreni, deps } = o;
  const force = !!o.force;
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
  deps.print(await deps.backup(o.config, 'pre-upgrade'));
  await me.lifecycles.activate(version, { force });
  deps.print(`upgraded to ${target}`);
}

/**
 * How the project's lifecycle differs from this Shreni's, or null when they
 * match: an older one is upgraded with shreni task upgrade, a newer (or
 * another) one needs a newer Shreni.
 */
export async function lifecycleGap(shreni: ShreniClient, projectId: string): Promise<{ on: string; runs: string; newer: boolean } | null> {
  const p = await shreni.tg.projects.get(projectId);
  const { name, version } = shreni.tg.lifecycle;
  if (p.lifecycleName === name && p.lifecycleVersion === version) return null;
  return {
    on: `${p.lifecycleName}@${p.lifecycleVersion}`, runs: `${name}@${version}`,
    newer: p.lifecycleName !== name || p.lifecycleVersion > version,
  };
}

/** What a gap means for a Kshetra, in words. */
export function lifecycleGapMessage(id: string, gap: { on: string; runs: string; newer: boolean }): string {
  return gap.newer
    ? `${id}: its project is on ${gap.on}, newer than this Shreni's ${gap.runs}; upgrade Shreni instead`
    : `${id}: its project is on ${gap.on}, older than this Shreni's ${gap.runs}`;
}

/**
 * Before a worker starts (policy spec, "Lifecycle upgrades in practice"): a
 * project on an older lifecycle is shown the change and asked, in a terminal;
 * a detached start refuses and prints the command.
 */
export async function ensureLifecycleCurrent(k: KshetraConfig, overrides: Partial<TaskDeps> = {}): Promise<void> {
  const deps: TaskDeps = { ...defaultDeps(), ...overrides };
  const conn = await deps.open(k);
  try {
    const gap = await lifecycleGap(conn.shreni, k.project!);
    if (!gap) return;
    if (gap.newer) throw new Error(lifecycleGapMessage(k.id, gap));
    if (!deps.interactive()) {
      throw new Error(`${lifecycleGapMessage(k.id, gap)}; run shreni start in a terminal to see the change and upgrade it`);
    }
    // No worker may hold it, here or elsewhere: an upgrade changes the rules under it.
    const tg = conn.shreni.tg.project(k.project!);
    const holder = await tg.locks.holder('worker');
    if (holder !== null) throw new Error(`${lifecycleGapMessage(k.id, gap)}, and a worker (${holder || 'on another machine'}) still holds it; stop that worker first`);
    const user = deps.user();
    if (!user) throw new Error('no developer to act as: set user in ~/.shreni/config.yaml, or git config user.email');
    deps.print(`${lifecycleGapMessage(k.id, gap)}.`);
    await upgradeProject({ tg, me: tg.as({ id: user, role: 'developer' }), shreni: conn.shreni, config: k, deps });
  } finally {
    await conn.close().catch(() => {});
  }
}

/** How long prime waits for the database before printing without the memories. */
const PRIME_CONNECT_S = 3;

/** Where a project's block goes (policy spec, "Instructions for agent sessions"). */
export function instructionTargets(found: FoundConfig<ProjectConfig>): {
  repo: string; mode: 'kshetra' | 'tracker'; files: string[]; claude: boolean;
} {
  if (found.kind === 'kshetra') {
    // A Kshetra's file is its configured provider's, and any other agent CLI's
    // file that holds a Shreni block, so a tracker block left from before never survives.
    const k = found.config as KshetraConfig;
    const repo = k.repo?.path ?? dirname(dirname(found.path));
    const own = join(repo, providerInstructionFile(k.agents.provider));
    const others = Object.keys(PROVIDER_REGISTRY).map(p => join(repo, providerInstructionFile(p as Provider)))
      .filter(f => f !== own && existsSync(f) && readFileSync(f, 'utf8').includes('<!-- shreni:begin '));
    return { repo, mode: 'kshetra', files: [own, ...new Set(others)], claude: k.agents.provider === 'anthropic' };
  }
  // A tracker's are one per agent CLI people use in the repo.
  const repo = dirname(dirname(found.path));
  const providers = (found.config as TrackerConfig).providers.map(providerFromCliName);
  return {
    repo, mode: 'tracker',
    files: [...new Set(providers.map(p => join(repo, providerInstructionFile(p))))],
    claude: providers.includes('anthropic'),
  };
}

/** Writes the block into each file and, for Claude Code, the prime hooks; returns what it did, a line each. */
export function setupInstructions(found: FoundConfig<ProjectConfig>): string[] {
  const t = instructionTargets(found);
  const out = t.files.flatMap(f => [`${f}: ${writeBlock(f, t.mode)}`, ...(leftoverWarning(f) ?? [])]);
  if (t.claude) out.push(`${join(t.repo, '.claude', 'settings.json')}: ${installPrimeHooks(t.repo) ? 'prime hooks installed' : 'prime hooks unchanged'}`);
  return out;
}

async function setup(ctx: CommandContext, deps: TaskDeps): Promise<void> {
  parseArgs(ctx.args, { command: 'shreni task setup' });
  const found = resolveProject(deps.cwd, deps.env, { requireProject: false });
  // A Kshetra with no project is still on beads: its block and hooks come with shreni migrate.
  if (found.kind === 'kshetra' && !found.config.project) throw new NotMigratedError(found.kshetraId ?? found.config.name);
  for (const l of setupInstructions(found)) deps.print(l);
}

/**
 * The block's rules and the project's memories, as the session-start and
 * pre-compaction hooks print them; a file whose block is missing, of the
 * other kind or behind is warned about, never edited.
 */
async function prime(ctx: CommandContext, deps: TaskDeps): Promise<void> {
  parseArgs(ctx.args, { command: 'shreni task prime' });
  const found = resolveProject(deps.cwd, deps.env, { requireProject: false });
  const t = instructionTargets(found);
  const out = [blockBody(t.mode)];
  if (found.config.project) {
    try {
      // A hook at every session start: an unreachable server costs seconds, not half a minute.
      const conn = await deps.open(found.config, { connectTimeout: PRIME_CONNECT_S });
      try {
        const rows = await conn.shreni.db.selectFrom('shreni.memories').select(['key', 'content'])
          .where('project_id', '=', found.config.project).orderBy('key').execute();
        if (rows.length) out.push('', '## Memories', '', ...rows.map(r => `- **${r.key}**: ${r.content}`));
      } finally {
        await conn.close().catch(() => {});
      }
    } catch (err) {
      // A session still gets the rules when the database is down.
      out.push('', `(memories unavailable: ${(err as Error).message})`);
    }
  } else {
    out.push('', '(this repo names no project yet; run shreni init)');
  }
  const problems = t.files.map(f => blockProblem(f, t.mode)).filter((p): p is string => !!p);
  if (problems.length) out.push('', ...problems.map(p => `Warning: ${p}`));
  deps.print(out.join('\n'));
}

type Run = (s: {
  ctx: CommandContext; deps: TaskDeps; tg: ProjectHandle; me: ActorHandle; shreni: ShreniClient;
  found: ReturnType<typeof findProjectConfig>; user: string;
}) => Promise<void>;

/** The open plan a task was filed in: neither approved nor discarded, so work may still join it. */
async function openPlanOf(tg: ProjectHandle, taskId: string): Promise<string | null> {
  const t = await tg.tasks.get(taskId).catch(err => {
    if (err instanceof NotFound) return null;
    throw err;
  });
  if (!t?.planId) return null;
  const plan = await tg.plans.get(t.planId);
  return plan.approvedAt || plan.discardedAt ? null : plan.id;
}

type Changes = Record<string, { from: unknown; to: unknown }> | undefined;

/** What an edit changed, in words, in a fixed order (task.updated's payload is jsonb, which keeps none). */
function describeChanges(changes: Changes): string {
  const order = ['title', 'description', 'priority', 'parent', 'kind', 'tags', 'category', 'holdUntil', 'spec'];
  const keys = Object.keys(changes ?? {}).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys.map(k => {
    const { from, to } = changes![k];
    if (k === 'title') return `title ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
    if (k === 'priority') return `priority ${from} → ${to}`;
    if (k === 'parent') return `parent ${from ?? 'none'} → ${to ?? 'none'}`;
    // A description can be long: whether it was set, cleared or changed is enough here.
    if (k === 'description') return `description ${from == null ? 'set' : to == null ? 'cleared' : 'changed'}`;
    return `${k} changed`;
  }).join(', ') || 'nothing';
}

/** The one task id a subcommand takes. */
function oneId(a: { positionals: string[] }, usage: string): string {
  const [id] = a.positionals;
  if (!id) throw new Error(`Usage: shreni task ${usage}`);
  return id;
}

const SUBCOMMANDS: Record<Exclude<(typeof TASK_SUBCOMMANDS)[number], 'setup' | 'prime'>, Run> = {
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
    deps.print(tasks.length ? treeLines(tasks, deps.color).join('\n') : 'no tasks');
  },

  async show({ ctx, deps, tg, shreni }) {
    const a = parseArgs(ctx.args, { positionals: 1 });
    const json = a.bools.has('--json');
    const [id] = a.positionals;
    if (!id) throw new Error('Usage: shreni task show <id>');
    const task = await tg.tasks.get(id);
    const checks = await shreni.db.selectFrom('shreni.acceptance_checks').select(['given', 'when', 'then', 'mode'])
      .where('project_id', '=', tg.id).where('task_id', '=', id).orderBy('created_at').orderBy('id').execute();
    // Notes, moves with a reason, and edits (task.updated), oldest first.
    const notes = (await tg.tasks.history(id)).flatMap(e => {
      const [kind, text] = e.kind === 'note' ? ['note', String(e.payload?.text)]
        : e.kind.startsWith('move:') && typeof e.payload?.reason === 'string' ? ['move', `${e.kind.slice(5)}: ${e.payload.reason}`]
          : e.kind === 'task.updated' ? ['edit', `edited: ${describeChanges(e.payload?.changes as Changes)}`]
            : [null, null];
      return kind === null ? [] : [{ at: e.at, actor: e.actor, kind, text }];
    });
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
      out.push('', 'History:');
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
    // An epic filed by hand is a plan, so approving it opens its tasks in one
    // step: a new epic starts a plan, and work under an epic whose plan is still
    // open joins it. Under an approved epic, work is a lone task again.
    if (parent) await tg.tasks.get(parent);   // a parent that isn't there fails before any plan is started
    const parentPlan = parent ? await openPlanOf(tg, parent) : null;
    const newPlan = !parentPlan && a.bools.has('--epic') ? (await me.plans.create({ title })).id : null;
    let plan = parentPlan ?? newPlan;
    const file = () => me.tasks.create({
      title,
      ...(description ? { description } : {}),
      ...(parent ? { parent } : {}),
      ...(plan ? { plan } : {}),
      ...(priority !== undefined ? { priority: Number(priority) } : {}),
      ...(a.bools.has('--epic') ? { kind: 'container' as const } : {}),
    });
    let task: Task;
    try {
      task = await file();
    } catch (err) {
      if (parentPlan && err instanceof InvalidRequest && !(await openPlanOf(tg, parent!))) {
        // The parent's plan was approved meanwhile: later work under it is a lone task.
        plan = null;
        task = await file();
      } else {
        // A plan started for this epic and left empty is discarded, not left open.
        if (newPlan) await me.plans.discard(newPlan, { via: 'cli' }).catch(() => {});
        throw err;
      }
    }
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
    deps.print(`filed ${task.id} (${task.state})${plan ? ` in plan ${plan}` : ''}: ${task.title}` +
      `${checks.length ? ` · ${checks.length} check${checks.length > 1 ? 's' : ''}` : ''}`);
  },

  async edit({ ctx, deps, tg, me, shreni }) {
    const a = parseArgs(ctx.args, {
      valued: ['--title', '--description', '--priority', '--parent'], repeated: ['--check'], bool: ['--no-parent', '--clear-checks'], positionals: 1,
    });
    const id = oneId(a, EDIT_USAGE);
    const { '--title': title, '--description': description, '--priority': priority, '--parent': parent } = a.values;
    const clear = a.bools.has('--clear-checks');
    // Everything is read before anything is changed, so a bad flag changes nothing.
    if (title !== undefined && !title.trim()) throw new Error('--title can\'t be empty');
    if (priority !== undefined && !/^[0-4]$/.test(priority)) throw new Error('--priority takes 0 to 4');
    if (parent !== undefined && a.bools.has('--no-parent')) throw new Error('give --parent or --no-parent, not both');
    const checks = (a.repeated['--check'] ?? []).map(parseCheck);
    const patch: TaskPatch = {
      ...(title !== undefined ? { title } : {}),
      // An empty description clears it.
      ...(description !== undefined ? { description: description.trim() ? description : null } : {}),
      ...(priority !== undefined ? { priority: Number(priority) } : {}),
      ...(parent !== undefined ? { parent } : a.bools.has('--no-parent') ? { parent: null } : {}),
    };
    if (!Object.keys(patch).length && !checks.length && !clear) throw new Error(`Usage: shreni task ${EDIT_USAGE}`);
    const task = await tg.tasks.get(id);
    if (taskLifecycle.states[task.state]?.terminal) throw new Error(`${id} is ${task.state}: a finished task isn't edited`);
    if (!EDITABLE.includes(task.state)) {
      // A claimed task's work is under way on what it says; whoever holds it gives it back first.
      throw new Error(`${id} is ${task.state}; ${task.state === 'claimed' ? 'release it first' : `a task is edited while ${EDITABLE.join(', ')}`}`);
    }
    if (checks.length && task.kind === 'container') throw new Error('an epic takes no --check; give its tasks the checks');
    if (patch.parent !== undefined && patch.parent !== task.parentId) {
      // A plan is approved as one (031a.18), and an edit can't move a task between
      // plans: a task moved into or out of an open plan would open without it, or with it.
      const from = await openPlanOf(tg, id);
      const to = patch.parent ? await openPlanOf(tg, patch.parent) : null;
      if (from !== to) {
        throw new Error(from
          ? `${id} is in plan ${from}, still to be approved as one; moving it would take it out: cancel it, and file it again where it belongs`
          : `${patch.parent} is in plan ${to}, still to be approved; ${id} can't join it by an edit: cancel it, and file it again with --parent ${patch.parent}`);
      }
    }

    const changed: string[] = [];
    if (Object.keys(patch).length) {
      // The engine records the change (task.updated, with the old and new values) only when there is one.
      const after = await me.tasks.update(id, patch);
      // Only the fields asked for: another writer's change meanwhile isn't this edit's.
      for (const f of ['title', 'description', 'priority'] as const) if (f in patch && after[f] !== task[f]) changed.push(f);
      if ('parent' in patch && after.parentId !== task.parentId) changed.push('parent');
    }
    const before = clear ? await checksOf(shreni, tg.id, id) : [];
    if (checks.length || before.length) {
      try {
        await shreni.transaction(async db => {
          // The engine guards its fields; the checks are Shreni's, so the state is checked again here, locked.
          const { rows } = await sql<{ state: string }>`select state from taskgraph.tasks
            where project_id = ${tg.id} and id = ${id} for update`.execute(db);
          if (!EDITABLE.includes(rows[0]?.state ?? '')) throw new Error(`${id} became ${rows[0]?.state ?? 'gone'} meanwhile`);
          if (clear) await db.deleteFrom('shreni.acceptance_checks').where('project_id', '=', tg.id).where('task_id', '=', id).execute();
          if (checks.length) {
            await db.insertInto('shreni.acceptance_checks')
              // As in create: each check a microsecond on, to read back in order.
              .values(checks.map((c, i) => ({
                project_id: tg.id, task_id: id, ...c, mode: 'auto',
                created_at: sql<Date>`now() + ${i} * interval '1 microsecond'`,
              })))
              .execute();
          }
        });
      } catch (err) {
        throw new Error(`${changed.length ? `edited ${id}'s ${changed.join(', ')}, but ` : ''}its checks were not changed: ${(err as Error).message}`);
      }
      // The checks are Shreni's, not the engine's, so their change is recorded as a note on the task.
      const text = `edited checks: ${[
        ...(before.length ? [`removed ${before.length}`] : []),
        ...(checks.length ? [`added: ${checks.map(c => `Given ${c.given}, when ${c.when}, then ${c.then}`).join('; ')}`] : []),
      ].join('; ')}`;
      try {
        await me.notes.add(id, text);
      } catch (err) {
        throw new Error(`${id}'s checks were changed, but the note recording it failed (${(err as Error).message}); note it by hand: ${text}`);
      }
      changed.push('checks');
    }
    deps.print(changed.length ? `edited ${id}: ${changed.join(', ')}` : `nothing changed on ${id}`);
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

  async confirm({ ctx, deps, tg, me, shreni, user }) {
    const a = parseArgs(ctx.args, { valued: ['--reason'], positionals: 1 });
    const id = oneId(a, 'confirm <id>');
    // Refused before the question when there is nothing to confirm.
    const { checks } = await confirmable(shreni, tg, id);
    deps.print([`${id}'s acceptance checks:`, ...checks.map(c => `  - (${c.mode}) Given ${c.given}, when ${c.when}, then ${c.then}`)].join('\n'));
    if (!/^y(es)?$/i.test((await deps.ask('Do all of these hold? [y/N] ')).trim())) throw new Error('not confirmed');
    await confirmByHand(shreni, tg, me, id, { reason: a.values['--reason']?.trim() || `acceptance checks confirmed by ${user}` });
    deps.print(`confirmed and finished ${id}`);
  },

  async unblock({ ctx, deps, tg, me, found }) {
    const a = parseArgs(ctx.args, { valued: ['--reason'], positionals: 1 });
    const id = oneId(a, 'unblock <id> --reason "…"');
    const reason = a.values['--reason']?.trim();
    if (!reason) throw new Error('Usage: shreni task unblock <id> --reason "…" (what was dealt with)');
    const t = await tg.tasks.get(id);
    if (t.state !== 'blocked') throw new Error(`${id} is ${t.state}, not blocked`);
    await me.move(id, 'unblock', { reason });
    deps.print(`unblocked ${id}: open again`);
    // A branch a declined PR or a failed push left behind stops the worker's
    // preflight; it may hold work done by hand, so it's named, never deleted.
    const repo = found.kind === 'kshetra' ? (found.config as KshetraConfig).repo?.path : undefined;
    const left = repo && !t.boosted ? leftBranches(repo, id) : [];
    for (const b of left) {
      deps.print(`  ${b} is still there, so the worker won't start ${id} afresh; delete it first: git -C ${repo} branch -D ${b}`);
    }
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
    // A plan by its id, or the open plan a task was filed in (an epic filed by
    // hand and its tasks): approving it opens the whole plan.
    const asPlan = await tg.plans.get(id).catch(err => {
      if (err instanceof NotFound) return null;
      throw err;
    });
    const planId = asPlan ? id : await openPlanOf(tg, id);
    const plan = asPlan ?? (planId ? await tg.plans.get(planId) : null);
    // What is approved is shown first, checks included: the tasks, and the validators' findings.
    const shown = async (t: Task) => [
      `  ${line(t)}`,
      ...(await checksOf(shreni, tg.id, t.id)).map(c => `      Given ${c.given}, when ${c.when}, then ${c.then}${c.mode === 'manual' ? ' (manual)' : ''}`),
    ];
    const planTasks = () => tg.tasks.list({ plan: planId!, orderBy: 'created' });
    const before = plan ? await planTasks() : [await tg.tasks.get(id)];
    if (planId && !asPlan) {
      // Named by one of its tasks: say so, unless that task is the plan's only root (its epic).
      const inPlan = new Set(before.map(t => t.id));
      const roots = before.filter(t => !t.parentId || !inPlan.has(t.parentId));
      if (roots.length !== 1 || roots[0].id !== id) deps.print(`${id} is in plan ${planId}; approving it opens the whole plan`);
    }
    const out = [plan ? `plan ${planId}: ${plan.title}` : 'task'];
    for (const t of before) out.push(...await shown(t));
    if (plan) {
      const report = await me.plans.validate(planId!);
      for (const f of report.findings) out.push(`  ${f.severity}: ${f.message}`);
      deps.print(out.join('\n'));
      if (!report.ok) throw new Error(`plan ${planId} doesn't pass validation; fix the errors above first`);
    } else {
      deps.print(out.join('\n'));
    }
    // The id typed back: approving is the step that makes work runnable.
    if ((await deps.ask(`Type ${id} to approve it: `)).trim() !== id) throw new Error('not approved');
    if (plan) {
      // Approve only what was shown: a plan still being filed may have grown meanwhile.
      const now = (await planTasks()).map(t => t.id).sort().join(',');
      if (now !== before.map(t => t.id).sort().join(',')) throw new Error(`plan ${planId} changed while you looked; run approve again`);
      for (const f of (await me.plans.approve(planId!, { via: 'cli' })).findings) deps.print(`  ${f.severity}: ${f.message}`);
      const opened = before.filter(t => t.state === 'proposed').length;
      deps.print(`approved ${id}: ${opened} task${opened === 1 ? '' : 's'} open`);
    } else {
      await me.tasks.approve(id, { via: 'cli' });
      deps.print(`approved ${id}`);
    }
  },

  async upgrade({ ctx, deps, tg, me, shreni, found }) {
    const a = parseArgs(ctx.args, { bool: ['--force'] });
    await upgradeProject({ tg, me, shreni, config: found.config, deps, force: a.bools.has('--force') });
  },
};
