import { sql } from 'kysely';
import { NotFound, type Actor } from '../../taskgraph';
import { SHRENI_VERSION, SHRENI_WRITER_SETTING } from '../db/migrate';
import { ShreniSchemaBehind } from '../db/errors';
import type { ShreniClient } from '../db/client';

// Init's Project phase (policy spec, "Init"): registers the repo's project in
// the database, with its mode, or finds the one its config already names.

export type ProjectMode = 'kshetra' | 'tracker';

export interface RegisterInput {
  /** The uuid the repo's config already names, if any. */
  id?: string;
  name: string;
  idPrefix: string;
  mode: ProjectMode;
  repoUrl?: string;
  actor: Actor;
}

/** A project id prefix from a name: what the engine accepts, kept readable. */
export function idPrefixFor(name: string): string {
  const p = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (!p) throw new Error(`can't make a task id prefix from ${JSON.stringify(name)}; pass --slug with letters or digits`);
  return p;
}

/**
 * Registers the project, the engine's row and Shreni's in one transaction, or,
 * when the config names one already, checks it is in this database and records
 * the mode. Returns its id, and whether it was created.
 */
export async function registerProject(shreni: ShreniClient, input: RegisterInput): Promise<{ id: string; created: boolean }> {
  const write = async (db: Parameters<Parameters<ShreniClient['transaction']>[0]>[0], id: string) => {
    await sql`select set_config(${SHRENI_WRITER_SETTING}, ${String(SHRENI_VERSION)}, true)`.execute(db);
    await sql`
      insert into shreni.projects (project_id, mode, repo_url) values (${id}, ${input.mode}, ${input.repoUrl ?? null})
      on conflict (project_id) do update set mode = excluded.mode, repo_url = coalesce(excluded.repo_url, shreni.projects.repo_url)`.execute(db);
  };
  if (input.id) {
    try {
      await shreni.tg.projects.get(input.id);
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
      throw new Error(`the config names project ${input.id}, which isn't in this database; point database: at the one that holds it, or delete project: to register a new one`);
    }
    await shreni.transaction(db => write(db, input.id!));
    return { id: input.id, created: false };
  }
  try {
    const p = await shreni.tg.projects.create({ name: input.name, idPrefix: input.idPrefix, actor: input.actor }, ({ db, project }) => write(db, project.id));
    return { id: p.id, created: true };
  } catch (err) {
    if ((err as { code?: string })?.code === 'SH001') throw new ShreniSchemaBehind((err as Error).message);
    throw err;
  }
}

/** The mode the database records for a project, or null when Shreni has no row for it. */
export async function projectMode(shreni: ShreniClient, id: string): Promise<ProjectMode | null> {
  const r = await sql<{ mode: ProjectMode }>`select mode from shreni.projects where project_id = ${id}`.execute(shreni.db);
  return r.rows[0]?.mode ?? null;
}
