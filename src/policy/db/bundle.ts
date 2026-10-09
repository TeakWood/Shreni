import { sql, type Kysely } from 'kysely';
import type { Actor, ImportReport, ProjectBundle } from '../../taskgraph';
import type { ShreniClient } from './client';
import { ShreniSchemaBehind } from './errors';
import { SHRENI_VERSION, SHRENI_WRITER_SETTING } from './migrate';

// A project with Shreni's rows (policy spec, "Shreni's tables"; engine spec,
// "Import, export and purge"). The engine's bundle carries only its own rows,
// and a purge cascades to Shreni's, so freeze, restore and moving a project
// go through these: the export wraps the engine's bundle with Shreni's rows,
// and the import writes them back inside the engine import's transaction.

export const SHRENI_BUNDLE_FORMAT = 'shreni.project';

/** Shreni's tables, parents first, as they are written back. */
const TABLES = ['projects', 'intents', 'acceptance_checks', 'attempt_evidence', 'memories'] as const;
type Table = (typeof TABLES)[number];

export type ShreniBundle = {
  format: typeof SHRENI_BUNDLE_FORMAT;
  version: 1;
  engine: ProjectBundle;
  /** Each table's rows as JSON, in a stable order. */
  shreni: Record<Table, Record<string, unknown>[]>;
};

/** The rows of one table that belong to the project, oldest key first. */
function rowsOf(table: Table, projectId: string) {
  switch (table) {
    case 'attempt_evidence':
      // The project is the attempt's.
      return sql<{ row: Record<string, unknown> }>`
        select to_jsonb(x) as row from shreni.attempt_evidence x
          join taskgraph.attempts a on a.id = x.attempt_id
         where a.project_id = ${projectId} order by x.attempt_id`;
    case 'projects':
      return sql<{ row: Record<string, unknown> }>`select to_jsonb(x) as row from shreni.projects x where project_id = ${projectId}`;
    case 'intents':
      return sql<{ row: Record<string, unknown> }>`select to_jsonb(x) as row from shreni.intents x where project_id = ${projectId} order by plan_id`;
    case 'acceptance_checks':
      return sql<{ row: Record<string, unknown> }>`select to_jsonb(x) as row from shreni.acceptance_checks x where project_id = ${projectId} order by created_at, id`;
    case 'memories':
      return sql<{ row: Record<string, unknown> }>`select to_jsonb(x) as row from shreni.memories x where project_id = ${projectId} order by key`;
  }
}

/** The project's last event id, the version freeze and lot manifests record; null for a project with none. */
export async function lastEventId(shreni: ShreniClient | { db: Kysely<any> }, projectId: string): Promise<string | null> {
  const r = await sql<{ id: string | null }>`
    select max(id)::text as id from taskgraph.events where project_id = ${projectId}`.execute(shreni.db);
  return r.rows[0]?.id ?? null;
}

/**
 * The project's engine bundle, Shreni's rows and its last event id, all read
 * in the engine export's one snapshot, so they agree with each other.
 */
export async function snapshotShreniProject(
  shreni: ShreniClient, projectId: string,
): Promise<{ bundle: ShreniBundle; lastEventId: string | null }> {
  const out = {} as ShreniBundle['shreni'];
  let last: string | null = null;
  const engine = await shreni.tg.projects.export(projectId, async ({ db }) => {
    for (const t of TABLES) out[t] = (await rowsOf(t, projectId.toLowerCase()).execute(db)).rows.map(r => r.row);
    last = await lastEventId({ db }, projectId.toLowerCase());
  });
  return { bundle: { format: SHRENI_BUNDLE_FORMAT, version: 1, engine, shreni: out }, lastEventId: last };
}

/** The project's engine bundle and Shreni's rows. */
export async function exportShreniProject(shreni: ShreniClient, projectId: string): Promise<ShreniBundle> {
  return (await snapshotShreniProject(shreni, projectId)).bundle;
}

/**
 * Refuses a bundle this process can't import, before anything is deleted for
 * it: the wrong format, another lifecycle version, or Shreni rows whose
 * columns differ from the tables' (a bundle from another Shreni schema).
 */
export async function checkShreniBundle(shreni: ShreniClient, bundle: ShreniBundle): Promise<void> {
  if (bundle?.format !== SHRENI_BUNDLE_FORMAT || bundle.version !== 1) {
    throw new Error(`not a Shreni project bundle (format ${String(bundle?.format)}, version ${String(bundle?.version)})`);
  }
  const { lifecycle } = shreni.tg;
  const p = bundle.engine?.project;
  if (p?.lifecycleName !== lifecycle.name || p?.lifecycleVersion !== lifecycle.version) {
    throw new Error(`the bundle is on lifecycle ${String(p?.lifecycleName)}@${String(p?.lifecycleVersion)}; this Shreni runs ${lifecycle.name}@${lifecycle.version}`);
  }
  const cols = await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name from information_schema.columns where table_schema = 'shreni'`.execute(shreni.db);
  for (const t of TABLES) {
    const want = cols.rows.filter(c => c.table_name === t).map(c => c.column_name).sort().join(',');
    for (const row of bundle.shreni?.[t] ?? []) {
      const have = Object.keys(row).sort().join(',');
      if (have !== want) throw new Error(`the bundle's shreni.${t} rows have columns ${have}; this database's have ${want}`);
    }
  }
}

/** Imports the engine's bundle and writes Shreni's rows back in the same transaction. */
export async function importShreniProject(
  shreni: ShreniClient, bundle: ShreniBundle, opts: { actor: Actor },
): Promise<ImportReport> {
  await checkShreniBundle(shreni, bundle);
  try {
    return await shreni.tg.projects.import(bundle.engine, opts, async ({ db }) => {
      await sql`select set_config(${SHRENI_WRITER_SETTING}, ${String(SHRENI_VERSION)}, true)`.execute(db);
      for (const t of TABLES) {
        const rows = bundle.shreni[t] ?? [];
        if (!rows.length) continue;
        await sql`
          insert into ${sql.table(`shreni.${t}`)}
          select * from jsonb_populate_recordset(null::${sql.table(`shreni.${t}`)}, cast(cast(${JSON.stringify(rows)} as text) as jsonb))`.execute(db);
      }
    });
  } catch (err) {
    // The writer fence, as Shreni's own transactions report it.
    if ((err as { code?: string })?.code === 'SH001') throw new ShreniSchemaBehind((err as Error).message);
    throw err;
  }
}
