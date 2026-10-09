import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { createInterface } from 'readline';
import { sql } from 'kysely';
import * as yaml from 'js-yaml';
import { initKshetra, readProjectFields, recordProjectId, SHRENI_DIR, type InitEngine, type InitKshetraOpts } from './init-kshetra';
import { loadTrackerConfig } from '../kshetra/project-config';
import { loadUserConfig, resolveDatabase } from '../kshetra/user-config';
import { unregisterKshetra } from '../kshetra/registry';
import { loadKshetraConfig } from '../kshetra/config';
import { checkDatabase, type DbProbe } from '../policy/db/checks';
import { openKshetraEngine } from '../policy/sthapathi/connect';
import { idPrefixFor, registerProject, type ProjectMode } from '../policy/init/project';
import { ensureMigrated, migrateDeps, realProbe } from './db';
import { readPid, isAlive } from './pid';
import { setupInstructions } from './task';
import { migrateOffBeads } from '../policy/migrate/kshetra';
import { migrationsDir, preImportDump } from './migrate';

export interface InitOpts {
  mode?: string;
  /** A tracker's agent CLIs, comma-separated (claude, codex, gemini). */
  providers?: string;
  slug?: string;
  path?: string;
  org?: string;
  language?: string;
  provider?: string;
  model?: string;
  mergePolicy?: 'push' | 'pr';
  dryRun?: boolean;
  pack?: string;
  noPack?: boolean;
  upgrade?: boolean;
  /** Imports existing beads without asking, after the dry run passes. */
  yes?: boolean;
}

export interface InitDeps {
  interactive(): boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
  /** The Kshetra path: today's init-kshetra phases, with the engine's. */
  kshetra(opts: InitKshetraOpts): Promise<void>;
  /** The database and the project for a repo of the given name and mode. */
  engine(project: { name: string; mode: ProjectMode; yes?: boolean }): InitEngine;
  /** Whether a worker runs for the Kshetra on this machine. */
  workerRunning(id: string): boolean;
  unregister(id: string): void;
}

const MODES: readonly ProjectMode[] = ['kshetra', 'tracker'];
const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
type TrackerProvider = typeof PROVIDERS[number];

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>(res => rl.question(question, res));
  } finally {
    rl.close();
  }
}

/** What the engine's phases reach: the server's probe, the connection, the environment. */
export interface EngineIo {
  probe: DbProbe;
  open: typeof openKshetraEngine;
  env: NodeJS.ProcessEnv;
  /** What the Import phase uses: the pre-import dump, and where migrations are recorded. */
  dump(database: string): Promise<string>;
  manifestsDir: string;
}

/** Whether a beads export holds any issue. */
function hasBeadsIssues(dir: string): boolean {
  const file = join(dir, 'issues.jsonl');
  return existsSync(file) && /"_type":"issue"|"id":/.test(readFileSync(file, 'utf8'));
}

/** The Database phase and the Project phase, for a repo of the given name and mode. */
export function initEngine(
  deps: Pick<InitDeps, 'interactive' | 'ask' | 'print'>, project: { name: string; mode: ProjectMode; yes?: boolean },
  io: EngineIo = {
    probe: realProbe(), open: openKshetraEngine, env: process.env,
    dump: preImportDump, manifestsDir: migrationsDir(),
  },
): InitEngine {
  return {
    async database(database) {
      const target = resolveDatabase({ database }, loadUserConfig(), io.env);
      const report = await checkDatabase(target, io.probe, {
        interactive: deps.interactive(), ask: q => deps.ask(q), create: true, env: io.env,
        onLine: l => deps.print(`  ${l.severity === 'ok' ? '✓' : l.severity === 'warn' ? '!' : '✗'} ${l.text}`),
      });
      if (!report.ok) throw new Error(`the database check failed for "${target.name}"`);
      const conn = await io.open({ database }, { name: 'shreni-init' });
      let fresh: boolean;
      try {
        // A database with no Shreni schema yet is init's to set up, with nothing to dump first.
        fresh = !(await sql<{ t: string | null }>`select to_regclass('taskgraph.kysely_migration')::text as t`.execute(conn.shreni.db)).rows[0]?.t;
        if (fresh) await conn.shreni.migrate();
      } finally {
        await conn.close().catch(() => {});
      }
      if (!fresh) {
        await ensureMigrated({ id: project.name, database }, {
          ...migrateDeps(), open: io.open, env: io.env, interactive: deps.interactive, ask: deps.ask, print: deps.print,
        });
      }
    },
    async project({ database, existing, repoUrl, beads }) {
      const conn = await io.open({ database }, { name: 'shreni-init' });
      try {
        // The Import phase: a repo with beads data and no project yet moves its beads over.
        if (!existing && beads && hasBeadsIssues(beads.dir)) {
          const r = await migrateOffBeads(conn.shreni, {
            id: project.name, name: project.name, mode: project.mode, repo: beads.repo, beadsDir: beads.dir,
            configPath: beads.configPath, database, repoUrl: repoUrl || undefined, touches: [], instructions: () => {},
          }, {
            backup: () => io.dump(database), interactive: deps.interactive, ask: deps.ask,
            print: l => deps.print(`  ${l}`), manifestsDir: io.manifestsDir,
          // Init offers no undo: a rerun finds the project the config now names, and the pre-import dump is the way back.
          }, { yes: project.yes, keepManifest: false });
          if (r.outcome === 'aborted') throw new Error('the beads import was not done; fix what the dry run found, then run init again');
          return r.projectId!;
        }
        const user = loadUserConfig().user ?? 'developer';
        const r = await registerProject(conn.shreni, {
          id: existing, name: project.name, idPrefix: idPrefixFor(project.name), mode: project.mode,
          repoUrl: repoUrl || undefined, actor: { id: user, role: 'developer' },
        });
        deps.print(`  ${r.created ? 'registered' : 'found'} project ${project.name} (${r.id}) as a ${project.mode}`);
        return r.id;
      } finally {
        await conn.close().catch(() => {});
      }
    },
  };
}

export function defaultInitDeps(): InitDeps {
  const deps: InitDeps = {
    interactive: () => Boolean(process.stdin.isTTY),
    ask,
    print: l => console.log(l),
    kshetra: initKshetra,
    engine: p => initEngine(deps, p),
    workerRunning(id) {
      const pid = readPid(id);
      return pid !== null && isAlive(pid);
    },
    unregister: unregisterKshetra,
  };
  return deps;
}

/** The mode: the flag, else the question, which has no default; without a terminal, the flag is required. */
async function resolveMode(opts: InitOpts, deps: InitDeps): Promise<ProjectMode> {
  if (opts.mode !== undefined) {
    if (!MODES.includes(opts.mode as ProjectMode)) throw new Error(`--mode is kshetra or tracker, not ${JSON.stringify(opts.mode)}`);
    return opts.mode as ProjectMode;
  }
  if (!deps.interactive()) {
    throw new Error('shreni init needs --mode kshetra or --mode tracker when it can\'t ask: will Shreni work tasks in this repo, or only track them?');
  }
  for (;;) {
    const a = (await deps.ask('Will Shreni work tasks in this repo (kshetra), or only track them (tracker)? ')).trim().toLowerCase();
    if (a === 'kshetra' || a === 'work') return 'kshetra';
    if (a === 'tracker' || a === 'track') return 'tracker';
    deps.print('  answer kshetra or tracker');
  }
}

function parseProviders(text: string): TrackerProvider[] {
  const list = [...new Set(text.split(/[\s,]+/).map(p => p.trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter(p => !PROVIDERS.includes(p as TrackerProvider));
  if (bad.length || !list.length) throw new Error(`agent CLIs are ${PROVIDERS.join(', ')}; got ${JSON.stringify(text)}`);
  return list as TrackerProvider[];
}

/** The answer must be the project's name, typed back. */
async function confirmByName(deps: InitDeps, name: string, what: string): Promise<void> {
  if (!deps.interactive()) throw new Error(`${what} needs a terminal, to confirm by typing the project's name`);
  if ((await deps.ask(`${what}. Type ${name} to go ahead: `)).trim() !== name) throw new Error('not changed');
}

// `shreni init` (policy spec, "Init"): sets up either kind of project, and its
// first question decides which. A Kshetra runs today's init-kshetra phases with
// the database and project added; a tracker gets the database, the project and
// .shreni/tracker.yaml, and is never registered, so no worker can start on it.
export async function runInit(opts: InitOpts, deps: InitDeps = defaultInitDeps()): Promise<void> {
  const mode = await resolveMode(opts, deps);
  const rawPath = opts.path ?? (deps.interactive() ? await withDefault(deps, 'Repo path', process.cwd()) : process.cwd());
  const path = resolve(rawPath);
  const trackerPath = join(path, SHRENI_DIR, 'tracker.yaml');
  const kshetraPath = join(path, SHRENI_DIR, 'kshetra.yaml');
  const isTracker = existsSync(trackerPath);
  const isKshetra = existsSync(kshetraPath);
  const current = isTracker ? loadTrackerConfig(trackerPath) : undefined;
  // The name the repo already goes by: the tracker's, or the Kshetra's id.
  const slugDefault = current?.name ?? (isKshetra ? kshetraId(kshetraPath) : undefined) ?? basename(path);
  const slug = opts.slug ?? (deps.interactive() ? await withDefault(deps, mode === 'kshetra' ? 'Kshetra slug' : 'Project name', slugDefault) : slugDefault);

  if (mode === 'kshetra') {
    // Tracker to Kshetra: only ever asked for, and confirmed by name. A run
    // stopped part way has both files, and resumes without asking again.
    if (isTracker && !isKshetra && !opts.dryRun) {
      await confirmByName(deps, current!.name, `${path} is a tracker project; making it a Kshetra lets Shreni's workers take its tasks`);
    }
    return deps.kshetra({
      slug, path, org: opts.org, language: opts.language, provider: opts.provider,
      model: opts.model, mergePolicy: opts.mergePolicy, dryRun: opts.dryRun, pack: opts.pack, noPack: opts.noPack,
      upgrade: opts.upgrade,
      engine: deps.engine({ name: slug, mode: 'kshetra', yes: opts.yes }),
      ...(isTracker ? { replaces: trackerPath } : {}),
    });
  }
  return initTracker({ opts, deps, path, slug, trackerPath, kshetraPath, current });
}

/** The id a kshetra.yaml names, read without checking the rest of the file. */
function kshetraId(file: string): string | undefined {
  try {
    const id = (yaml.load(readFileSync(file, 'utf8')) as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function withDefault(deps: InitDeps, question: string, def: string): Promise<string> {
  return (await deps.ask(`${question} [${def}]: `)).trim() || def;
}

async function initTracker(a: {
  opts: InitOpts; deps: InitDeps; path: string; slug: string; trackerPath: string; kshetraPath: string;
  current: ReturnType<typeof loadTrackerConfig> | undefined;
}): Promise<void> {
  const { opts, deps, path, slug, trackerPath, kshetraPath, current } = a;
  // Kshetra to tracker: once no worker runs; it leaves the registry.
  let kshetra: { id: string; project?: string; database?: string } | undefined;
  if (existsSync(kshetraPath)) {
    const k = loadKshetraConfig(kshetraPath);
    kshetra = { id: k.id, project: k.project, database: k.database };
    if (deps.workerRunning(k.id)) throw new Error(`Kshetra ${k.id} has a worker running; shreni stop --kshetra ${k.id} first`);
    if (deps.interactive() && !/^y(es)?$/i.test((await deps.ask(`Make Kshetra ${k.id} a tracker project? No worker will take its tasks again [y/N] `)).trim())) {
      throw new Error('not changed');
    }
  }
  const providers = opts.providers
    ? parseProviders(opts.providers)
    : current?.providers ?? (deps.interactive()
      ? parseProviders((await deps.ask('Which agent CLIs do people use in this repo (claude, codex, gemini)? [claude]: ')).trim() || 'claude')
      : ['claude']);
  const database = current?.database ?? kshetra?.database ?? 'local';
  const existing = readProjectFields(trackerPath).project ?? kshetra?.project;

  if (opts.dryRun) {
    deps.print('--dry-run — plan only, nothing written:');
    deps.print(`  mode:      tracker`);
    deps.print(`  project:   ${slug}${existing ? ` (${existing})` : ' (new)'}`);
    deps.print(`  database:  ${database}`);
    deps.print(`  providers: ${providers.join(', ')}`);
    deps.print(`  config:    ${trackerPath}`);
    return;
  }

  const engine = deps.engine({ name: slug, mode: 'tracker', yes: opts.yes });
  const steps: { name: string; run(): Promise<void> }[] = [
    { name: 'Database', run: () => engine.database(database) },
    {
      name: 'Config',
      run: async () => {
        mkdirSync(join(path, SHRENI_DIR), { recursive: true });
        // Settings a person added stay; init owns only these.
        if (!existsSync(trackerPath)) {
          writeFileSync(trackerPath, yaml.dump({ name: slug, database, ...(existing ? { project: existing } : {}), providers }, { lineWidth: -1 }), 'utf8');
          return;
        }
        // An existing file is rewritten only when a setting init owns changes,
        // judged with the defaults applied, so its comments stay otherwise.
        const now = loadTrackerConfig(trackerPath);
        if (now.name !== slug || now.database !== database || JSON.stringify(now.providers) !== JSON.stringify(providers)) {
          const doc = yaml.load(readFileSync(trackerPath, 'utf8')) as Record<string, unknown>;
          writeFileSync(trackerPath, yaml.dump({ ...doc, name: slug, database, providers }, { lineWidth: -1 }), 'utf8');
        }
      },
    },
    {
      name: 'Project',
      run: async () => {
        const beadsDir = join(path, '.beads');
        recordProjectId(trackerPath, await engine.project({
          database, existing, repoUrl: '', ...(existsSync(beadsDir) ? { beads: { dir: beadsDir, repo: path, configPath: trackerPath } } : {}),
        }));
        if (kshetra) {
          deps.unregister(kshetra.id);
          // Kept aside, not deleted: it is gitignored, and holds the Kshetra's settings.
          renameSync(kshetraPath, `${kshetraPath}.bak`);
          deps.print(`  Kshetra ${kshetra.id} left the registry; its settings are kept in ${kshetraPath}.bak`);
        }
        // The schema checks the file as every later command will read it.
        loadTrackerConfig(trackerPath);
      },
    },
    {
      // The tracker block in each agent CLI's file, and the prime hooks for Claude Code.
      name: 'Instructions',
      run: async () => {
        for (const l of setupInstructions({ kind: 'tracker', path: trackerPath, config: loadTrackerConfig(trackerPath) })) deps.print(`  ${l}`);
      },
    },
  ];
  for (const step of steps) {
    deps.print(`▶ ${step.name} …`);
    try {
      await step.run();
    } catch (err) {
      deps.print(`  ✗ ${step.name} failed: ${(err as Error).message}`);
      deps.print(`  Then re-run (finished steps are skipped): shreni init --mode tracker --path ${path}`);
      throw err;
    }
    deps.print(`  ✓ ${step.name}`);
  }
  deps.print(`\n✓ ${slug} is a tracker project: work its tasks by hand with shreni task; commit ${join(SHRENI_DIR, 'tracker.yaml')}.`);
}

/**
 * What `shreni start` refuses, as the message: a tracker project is never
 * worked, so neither a Kshetra whose repo holds a tracker.yaml (a switch left
 * part way) nor, with nothing else to start, the tracker repo it runs in.
 */
export function startRefusal(cwd: string, targets: { id: string; repo: { path: string } }[], explicit: boolean): string | null {
  for (const k of targets) {
    const t = join(k.repo.path, SHRENI_DIR, 'tracker.yaml');
    if (existsSync(t)) return `${k.id}: its repo is a tracker project (${t}); finish shreni init --mode kshetra there first`;
  }
  const here = trackerAt(cwd);
  if (here && (explicit || !targets.length)) {
    return `this repo is a tracker project (${here}): Shreni never works its tasks; shreni init --mode kshetra makes it a Kshetra`;
  }
  return null;
}

/** The tracker.yaml of the repo `cwd` is in, if it is a tracker project. */
export function trackerAt(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = resolve(dir, '..')) {
    const t = join(dir, SHRENI_DIR, 'tracker.yaml');
    if (existsSync(t)) return t;
    if (existsSync(join(dir, '.git')) || resolve(dir, '..') === dir) return null;
  }
}
