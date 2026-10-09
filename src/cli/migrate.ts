import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline/promises';
import type { CommandContext } from './registry';
import { parseArgs, instructionTargets, setupInstructions } from './task';
import { legacyBeadsPath, loadKshetraConfig, type KshetraConfig } from '../kshetra/config';
import { loadRegistry, resolveConfigPath } from '../kshetra/registry';
import { loadUserConfig, resolveDatabase } from '../kshetra/user-config';
import { isLocal, pgTools, takeDump, WAIT_MS } from '../policy/db/backups';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import { migrateOffBeads, undoMigration, type MigrateIo, type MigrateTarget } from '../policy/migrate/kshetra';
import { readPid, isAlive } from './pid';

// shreni migrate <kshetra> (migration plan, "Upgrading a Kshetra"): moves a
// Kshetra off beads onto the task graph engine, or with --undo puts it back
// until the first write to the new store.

export const MIGRATE_USAGE = '<kshetra> [--yes] [--undo]';

export interface MigrateDeps extends Omit<MigrateIo, 'backup'> {
  open(k: Pick<KshetraConfig, 'database'>): Promise<KshetraEngine>;
  /** The dump before the import, of the named database, waited for. */
  dump(database: string): Promise<string>;
  workerRunning(id: string): boolean;
  kshetras(): KshetraConfig[];
  configPath(id: string): string | null;
}

export const migrationsDir = (home = homedir()) => join(home, '.shreni', 'migrations');

export function defaultMigrateDeps(): MigrateDeps {
  return {
    open: k => openKshetraEngine(k, { name: 'shreni-migrate' }),
    workerRunning(id) {
      const pid = readPid(id);
      return pid !== null && isAlive(pid);
    },
    kshetras: loadRegistry,
    configPath: resolveConfigPath,
    dump: preImportDump,
    interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    print: l => console.log(l),
    manifestsDir: migrationsDir(),
  };
}

/** The dump an import takes first (policy spec, "Backups"), and waits for. */
export async function preImportDump(database: string): Promise<string> {
  const target = resolveDatabase({ database }, loadUserConfig());
  if (!isLocal(target)) return `database "${target.name}" isn't on this machine: no dump taken; its owner backs it up`;
  return `dumped first: ${await takeDump(target, 'pre-import', pgTools, { wait: WAIT_MS })}`;
}

/**
 * What a Kshetra's migration works on. The beads data is at the legacy
 * `beads.path` the config file names (read from the file: the schema no longer
 * has it), else behind the repo's .beads link.
 */
export function kshetraTarget(k: KshetraConfig, configPath: string): MigrateTarget {
  const t = instructionTargets({ kind: 'kshetra', path: configPath, config: k });
  const beadsDir = legacyBeadsPath(configPath) ?? join(k.repo.path, '.beads');
  return {
    id: k.id, name: k.id, mode: 'kshetra', repo: k.repo.path, beadsDir, configPath, project: k.project,
    database: k.database ?? 'local', repoUrl: k.repo.remote,
    touches: [...t.files, ...(t.claude ? [join(t.repo, '.claude', 'settings.json')] : [])],
    instructions: () => { setupInstructions({ kind: 'kshetra', path: configPath, config: loadKshetraConfig(configPath) }); },
  };
}

export async function runMigrateCommand(ctx: CommandContext, overrides: Partial<MigrateDeps> = {}): Promise<void> {
  const deps: MigrateDeps = { ...defaultMigrateDeps(), ...overrides };
  // parseArgs reads past a subcommand at args[0]; this command has none, so one is put back.
  const a = parseArgs(['migrate', ...ctx.args], { command: 'shreni migrate', bool: ['--yes', '--undo'], positionals: 1 });
  const [id] = a.positionals;
  if (!id) throw new Error(`Usage: shreni migrate ${MIGRATE_USAGE}`);
  await migrateKshetra(id, deps, { yes: a.bools.has('--yes'), undo: a.bools.has('--undo') });
}

/** Moves one registered Kshetra off beads, or back with undo. */
export async function migrateKshetra(id: string, deps: MigrateDeps, opts: { yes?: boolean; undo?: boolean } = {}): Promise<void> {
  const k = deps.kshetras().find(x => x.id === id);
  const configPath = deps.configPath(id);
  if (!k || !configPath) throw new Error(`Kshetra not found: ${id}`);
  // Preflight: no worker, and a database with no migration pending.
  if (deps.workerRunning(id)) throw new Error(`${id} has a worker running; shreni stop --kshetra ${id} first`);
  const conn = await deps.open(k);
  try {
    const pending = [...await conn.shreni.tg.pendingMigrations(), ...await conn.shreni.pending()];
    if (pending.length) throw new Error(`the database has pending migrations (${pending.join(', ')}); run shreni db migrate first`);
    if (opts.undo) return await undoMigration(conn.shreni, id, configPath, deps);
    const { outcome } = await migrateOffBeads(conn.shreni, kshetraTarget(k, configPath), {
      ...deps, backup: () => deps.dump(k.database ?? 'local'),
    }, { yes: opts.yes });
    if (outcome === 'aborted') throw new Error(`${id} wasn't migrated`);
    deps.print(outcome === 'unchanged' ? `${id} is already on the engine; nothing to do` : `${id} is on the engine; commit the repo's changes`);
  } finally {
    await conn.close().catch(() => {});
  }
}
