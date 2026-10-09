import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { sql } from 'kysely';
import type { CommandContext } from './registry';
import type { ActorHandle, ProjectHandle, Task } from '../taskgraph';
import { loadKshetraConfig } from '../kshetra/config';
import { loadTrackerConfig, type ProjectConfig } from '../kshetra/project-config';
import { loadUserConfig } from '../kshetra/user-config';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import type { ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';

// shreni task (policy spec, "Working by hand" and "Project config"): a person,
// or a Claude Code session acting for them, reads and files work with the
// developer role. Each run finds its project from the repo's tracker.yaml or
// kshetra.yaml, and sweeps expired leases before anything else, so a claim that
// lapsed overnight is back in ready by morning. Claiming and finishing by hand
// come with claim, finish and release.

export const TASK_SUBCOMMANDS = ['ready', 'show', 'list', 'create', 'note', 'remember'] as const;
export const TASK_USAGE = `<${TASK_SUBCOMMANDS.join('|')}> …`;

const HELP = [
  'shreni task ready [--json]                    open tasks with nothing blocking them',
  'shreni task show <id> [--json]                a task, its checks, dependencies and notes',
  'shreni task list [--state <s,…>|--all] [--json]  tasks; every live one by default',
  'shreni task create --title "…" [--description "…"] [--parent <id>] [--priority 0-4] [--epic]',
  '                   [--check "given … when … then …"]…  lands as proposed, for the developer to approve',
  'shreni task note <id> "…"                     a note on a task',
  'shreni task remember "…" [--key <key>]        an insight for later sessions',
].join('\n');

/** The states a list shows by default: every one not yet terminal. */
const LIVE = ['proposed', 'open', 'claimed', 'waiting', 'blocked', 'parked'];

export interface TaskDeps {
  /** Where the project is looked for, walking up. */
  cwd: string;
  open(config: ProjectConfig): Promise<KshetraEngine>;
  /** The developer the calls act as: `user` in ~/.shreni/config.yaml, else git's user.email. */
  user(): string | undefined;
  print(line: string): void;
}

const defaultDeps = (): TaskDeps => ({
  cwd: process.cwd(),
  open: config => openKshetraEngine(config, { name: 'shreni-task' }),
  user: () => loadUserConfig().user,
  print: line => console.log(line),
});

/** The repo's project config, from the nearest .shreni/tracker.yaml or .shreni/kshetra.yaml above `cwd`. */
export function findProjectConfig(cwd: string): { kind: 'tracker' | 'kshetra'; path: string; config: ProjectConfig & { project: string } } {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const tracker = join(dir, '.shreni', 'tracker.yaml');
    const kshetra = join(dir, '.shreni', 'kshetra.yaml');
    const found = [existsSync(tracker) && tracker, existsSync(kshetra) && kshetra].filter((p): p is string => !!p);
    if (found.length > 1) throw new Error(`${dir} has both .shreni/tracker.yaml and .shreni/kshetra.yaml; a repo is one or the other`);
    if (found.length === 1) {
      const kind = found[0] === tracker ? 'tracker' : 'kshetra';
      const config: ProjectConfig = kind === 'tracker' ? loadTrackerConfig(found[0]) : loadKshetraConfig(found[0]);
      if (!config.project) throw new Error(`${found[0]} names no project yet; run shreni init`);
      return { kind, path: found[0], config: config as ProjectConfig & { project: string } };
    }
    // A repo's own root ends the walk, so a clone nested in a tracked repo never acts on the outer project.
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) {
      throw new Error(`no .shreni/tracker.yaml or .shreni/kshetra.yaml in ${resolve(cwd)} or above; run shreni init in the repo`);
    }
  }
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
  args: string[], spec: { valued?: string[]; repeated?: string[]; bool?: string[]; positionals?: number | 'rest' },
): { values: Record<string, string>; repeated: Record<string, string[]>; bools: Set<string>; positionals: string[] } {
  const valued = new Set([...(spec.valued ?? []), ...(spec.repeated ?? [])]);
  const bool = new Set([...(spec.bool ?? []), '--json']);
  const out = { values: {} as Record<string, string>, repeated: {} as Record<string, string[]>, bools: new Set<string>(), positionals: [] as string[] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (a.includes('=')) throw new Error(`write ${a.slice(0, a.indexOf('='))} <value>, not ${a}`);
      if (bool.has(a)) { out.bools.add(a); continue; }
      if (!valued.has(a)) throw new Error(`shreni task ${args[0]} takes no ${a}`);
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
  const { config } = findProjectConfig(deps.cwd);
  const user = deps.user();
  if (!user) throw new Error('no developer to act as: set user in ~/.shreni/config.yaml, or git config user.email');

  const conn = await deps.open(config);
  try {
    const tg = conn.shreni.tg.project(config.project);
    await tg.expireLeases();
    const me = tg.as({ id: user, role: 'developer' });
    await SUBCOMMANDS[sub as (typeof TASK_SUBCOMMANDS)[number]]({ ctx, deps, tg, me, shreni: conn.shreni });
  } finally {
    await conn.close().catch(() => {});
  }
}

type Run = (s: {
  ctx: CommandContext; deps: TaskDeps; tg: ProjectHandle; me: ActorHandle; shreni: ShreniClient;
}) => Promise<void>;

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
    await me.notes.add(id, text);
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
};
