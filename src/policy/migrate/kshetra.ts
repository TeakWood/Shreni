import { createHash, randomUUID } from 'crypto';
import { sql } from 'kysely';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { importShreniProject, lastEventId } from '../db/bundle';
import type { ShreniClient } from '../db/client';
import { dryRun, parseBeadsExport, renderDryRun } from './beads-import';
import type { ProjectMode } from '../init/project';
import { legacyBeadsPath } from '../../kshetra/config';

// Moving a project off beads (migration plan, "Upgrading a Kshetra"):
// preflight, dry run, confirmation, a dump, the import in one transaction,
// then the clean-up of the repo. Before anything changes, the project's id and
// every file the clean-up touches are saved, so a rerun finishes the job under
// the same id, and --undo puts the repo back exactly until the first write to
// the new store. The beads repo is never touched: it stays as an archive.

/** What a migration saved before changing anything, to finish or undo it. */
export type Manifest = {
  kshetra: string;
  /** The config of the repo it belongs to: another repo with the same name has its own. */
  configPath: string;
  projectId: string;
  projectName: string;
  /** The project's last event once the import committed; a later one means work began on the engine. */
  importedThrough: string | null;
  /** Shreni's own rows for the project once the import committed (memories write no event). */
  importedRows: string | null;
  /** Each file the clean-up may change, as it was (null: it didn't exist), in base64 so it comes back byte for byte. */
  files: { path: string; content: string | null }[];
  /** The repo's .beads symlink, when it had one. */
  symlink: { path: string; target: string } | null;
};

export interface MigrateIo {
  /** Dumps the database first, and waits; says where, or why none was taken. */
  backup(): Promise<string>;
  interactive(): boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
  /** Where manifests are kept (~/.shreni/migrations). */
  manifestsDir: string;
  now?: Date;
}

export type MigrateTarget = {
  /** The Kshetra's id, or a tracker's name: what manifests are kept under. */
  id: string;
  name: string;
  mode: ProjectMode;
  repo: string;
  beadsDir: string;
  /** The config file the project's id and database are recorded in. */
  configPath: string;
  /** The project the config already names, if any: then nothing is imported again. */
  project?: string;
  database: string;
  repoUrl?: string;
  /** The files the clean-up rewrites (instruction files, .claude/settings.json), saved for --undo. */
  touches: string[];
  /** Writes Shreni's block and hooks in place of the beads instructions. */
  instructions(): void;
};

/** One manifest per repo: the name, and a hash of the config's path. */
export const manifestPath = (io: Pick<MigrateIo, 'manifestsDir'>, id: string, configPath: string) =>
  join(io.manifestsDir, `${id}-${createHash('sha256').update(configPath).digest('hex').slice(0, 8)}.json`);

function readManifest(io: Pick<MigrateIo, 'manifestsDir'>, id: string, configPath: string): Manifest | null {
  const p = manifestPath(io, id, configPath);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}

function writeManifest(io: Pick<MigrateIo, 'manifestsDir'>, m: Manifest): void {
  mkdirSync(io.manifestsDir, { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath(io, m.kshetra, m.configPath), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
}

/** Shreni's own rows for the project, as a fingerprint: undo refuses once they change. */
async function shreniRows(shreni: ShreniClient, projectId: string): Promise<string> {
  const r = await sql<{ t: string; n: string; at: string | null }>`
    select 'memories' as t, count(*)::text as n, max(updated_at)::text as at from shreni.memories where project_id = ${projectId}
    union all select 'intents', count(*)::text, max(created_at)::text from shreni.intents where project_id = ${projectId}
    union all select 'checks', count(*)::text, max(created_at)::text from shreni.acceptance_checks where project_id = ${projectId}`.execute(shreni.db);
  return JSON.stringify(r.rows);
}

const isSymlink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Sets a top-level `key: value` line in a YAML file in place, keeping the rest. */
export function setTopLevel(file: string, key: string, value: string): void {
  const text = readFileSync(file, 'utf8');
  const line = `${key}: ${value}`;
  const re = new RegExp(`^["']?${key}["']?\\s*:.*$`, 'm');
  const next = re.test(text) ? text.replace(re, line) : /^name:.*$/m.test(text) ? text.replace(/^(name:.*)$/m, `$1\n${line}`) : `${line}\n${text}`;
  if (next !== text) writeFileSync(file, next, 'utf8');
}

export type MigrateOutcome = 'migrated' | 'finished' | 'unchanged' | 'aborted';

/**
 * Moves the target off beads. A first run checks, asks and imports; a rerun
 * after the import commits finds the project and only finishes the clean-up,
 * and a run with nothing left to do changes nothing.
 */
export async function migrateOffBeads(
  shreni: ShreniClient, t: MigrateTarget, io: MigrateIo, opts: { yes?: boolean; keepManifest?: boolean } = {},
): Promise<{ outcome: MigrateOutcome; projectId?: string }> {
  let manifest = readManifest(io, t.id, t.configPath);
  // A config that names a project is on the engine already: only the clean-up
  // may be left, never another import, unless a migration of its own is in flight.
  if (t.project && manifest?.projectId !== t.project) {
    if (!(await projectExists(shreni, t.project))) {
      throw new Error(`${t.configPath} names project ${t.project}, which isn't in this database; point database: at the one that holds it`);
    }
    const changed = cleanUp(t, t.project);
    for (const c of changed) io.print(`  ${c}`);
    return { outcome: changed.length ? 'finished' : 'unchanged', projectId: t.project };
  }
  const imported = manifest ? await projectExists(shreni, manifest.projectId) : false;
  if (manifest && !imported && manifest.importedThrough !== null) {
    throw new Error(`the migration recorded in ${manifestPath(io, t.id, t.configPath)} imported project ${manifest.projectId}, which is gone; remove that file and the config's project: line to migrate afresh`);
  }

  if (!imported) {
    // Preflight: the committed export is what is read; Shreni never runs bd.
    const issuesFile = join(t.beadsDir, 'issues.jsonl');
    io.print(`reading the committed ${issuesFile}; if bd is installed, run \`bd export -o ${issuesFile}\` first for the latest`);
    if (!existsSync(issuesFile)) throw new Error(`no ${issuesFile}; nothing to import`);
    const interactionsFile = join(t.beadsDir, 'interactions.jsonl');
    const src = parseBeadsExport(readFileSync(issuesFile, 'utf8'), existsSync(interactionsFile) ? readFileSync(interactionsFile, 'utf8') : '');

    // The id is chosen once, and kept, so a rerun imports under the same one.
    const projectId = manifest?.projectId ?? randomUUID();
    const r = dryRun(src, { name: t.name, mode: t.mode, lifecycle: taskLifecycle, projectId, repoUrl: t.repoUrl, now: io.now });
    for (const l of renderDryRun(r)) io.print(l);
    if (!r.ok) return { outcome: 'aborted' };

    if (!opts.yes) {
      if (!io.interactive()) throw new Error(`${t.id}: the migration needs a confirmation; run it in a terminal, or pass --yes`);
      if (!/^y(es)?$/i.test((await io.ask(`Import ${r.counts.engine.tasks} tasks into the database and move ${t.id} off beads? [y/N] `)).trim())) {
        io.print('not migrated');
        return { outcome: 'aborted' };
      }
    }

    // Everything the clean-up changes, saved before any of it.
    if (!manifest) {
      manifest = {
        kshetra: t.id, configPath: t.configPath, projectId, projectName: t.name, importedThrough: null, importedRows: null,
        files: [t.configPath, join(t.repo, '.gitignore'), ...t.touches].map(path => ({
          path, content: existsSync(path) ? readFileSync(path).toString('base64') : null,
        })),
        symlink: isSymlink(join(t.repo, '.beads')) ? { path: join(t.repo, '.beads'), target: readlinkSync(join(t.repo, '.beads')) } : null,
      };
      writeManifest(io, manifest);
    }

    io.print(await io.backup());
    const report = await importShreniProject(shreni, r.mapped.bundle, { actor: { id: 'beads-importer', role: 'system' } });
    manifest.importedThrough = await lastEventId(shreni, report.project.id);
    manifest.importedRows = await shreniRows(shreni, report.project.id);
    writeManifest(io, manifest);
    io.print(`imported ${report.counts.tasks ?? r.counts.engine.tasks} tasks as project ${t.name} (${report.project.id})`);
  }

  // A run that stopped between the commit and recording it records it now: nothing ran in between.
  if (imported && manifest!.importedThrough === null) {
    manifest!.importedThrough = await lastEventId(shreni, manifest!.projectId);
    manifest!.importedRows = await shreniRows(shreni, manifest!.projectId);
    writeManifest(io, manifest!);
  }
  const changed = cleanUp(t, manifest!.projectId);
  for (const c of changed) io.print(`  ${c}`);
  if (opts.keepManifest === false) rmSync(manifestPath(io, t.id, t.configPath), { force: true });
  return { outcome: imported ? (changed.length ? 'finished' : 'unchanged') : 'migrated', projectId: manifest!.projectId };
}

async function projectExists(shreni: ShreniClient, id: string): Promise<boolean> {
  return (await shreni.tg.projects.list()).some(p => p.id === id);
}

/**
 * The repo's side of the move, each step a no-op once done; returns what it
 * changed. The config names the project last, so a run stopped part way still
 * reads as on beads, and start offers to finish it.
 */
function cleanUp(t: MigrateTarget, projectId: string): string[] {
  const out: string[] = [];
  const link = join(t.repo, '.beads');
  if (isSymlink(link)) {
    unlinkSync(link);
    out.push(`removed the ${link} symlink; the beads repo stays as an archive`);
  }
  const gitignore = join(t.repo, '.gitignore');
  // Its ignore goes with the link; a real .beads directory stays, and stays ignored.
  if (existsSync(gitignore) && !existsSync(link)) {
    const text = readFileSync(gitignore, 'utf8');
    const next = text.split('\n').filter(l => l.trim() !== '.beads').join('\n');
    if (next !== text) {
      writeFileSync(gitignore, next, 'utf8');
      out.push(`${gitignore}: no longer ignores .beads`);
    }
  }
  const saved = t.touches.map(f => (existsSync(f) ? readFileSync(f, 'utf8') : null));
  t.instructions();
  t.touches.forEach((f, i) => {
    if ((existsSync(f) ? readFileSync(f, 'utf8') : null) !== saved[i]) out.push(`${f}: Shreni's block in place of the beads instructions`);
  });
  const before = readFileSync(t.configPath, 'utf8');
  setTopLevel(t.configPath, 'database', t.database);
  setTopLevel(t.configPath, 'project', projectId);
  if (readFileSync(t.configPath, 'utf8') !== before) out.push(`${t.configPath}: records project ${projectId}`);
  return out;
}

/**
 * Undoes a migration: purges the project and puts every saved file and the
 * symlink back exactly, as long as nothing has been written to the project
 * since the import.
 */
export async function undoMigration(
  shreni: ShreniClient, id: string, configPath: string, io: Pick<MigrateIo, 'manifestsDir' | 'print'>,
): Promise<void> {
  const m = readManifest(io, id, configPath);
  if (!m) throw new Error(`${id} has no migration to undo`);
  if (await projectExists(shreni, m.projectId)) {
    const last = await lastEventId(shreni, m.projectId);
    const rows = await shreniRows(shreni, m.projectId);
    if (m.importedThrough === null || last !== m.importedThrough || rows !== m.importedRows) {
      throw new Error(`${id}'s project has changed since the import (a new event, memory or check); work done on the engine has no way back into beads`);
    }
    await shreni.tg.projects.purge(m.projectId, { actor: { id: 'beads-importer', role: 'system' }, confirmName: m.projectName });
    io.print(`purged project ${m.projectName} (${m.projectId})`);
  }
  for (const f of m.files) {
    if (f.content === null) {
      if (existsSync(f.path)) rmSync(f.path);
    } else {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, Buffer.from(f.content, 'base64'));
    }
  }
  if (m.symlink && !isSymlink(m.symlink.path)) symlinkSync(m.symlink.target, m.symlink.path);
  rmSync(manifestPath(io, id, configPath));
  io.print(`${id} is back on beads`);
}

/**
 * The beads directory of a Kshetra still on beads: no project, and a beads
 * export to move, at the legacy `beads.path` its config file names (read from
 * the file, as the schema no longer has it). Undefined otherwise.
 */
export function onBeads(k: { project?: string; repo?: { path: string } }, configPath: string): string | undefined {
  if (k.project) return undefined;
  // Where shreni migrate looks too: the legacy beads.path, else the repo's .beads link.
  const dir = legacyBeadsPath(configPath) ?? (k.repo ? join(k.repo.path, '.beads') : undefined);
  return dir && existsSync(join(dir, 'issues.jsonl')) ? dir : undefined;
}
