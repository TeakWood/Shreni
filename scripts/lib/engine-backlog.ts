/**
 * The certification and e2e scripts' window onto a Kshetra's task graph: file a
 * backlog as the system role (so the tasks land open, ready to work) and read
 * the tasks' states back. In-process through the policy client, on the database
 * the Kshetra's config names (SHRENI_DATABASE_URL wins, as for the worker).
 */
import { readFileSync } from 'fs';
import { sql } from 'kysely';
import { loadKshetraConfig } from '../../src/kshetra/config.js';
import { openKshetraEngine, type KshetraEngine } from '../../src/policy/sthapathi/connect.js';
import { parseCheck } from '../../src/cli/task.js';

/** One task of a pack's reference/backlog.json. */
export interface BacklogItem {
  title: string;
  description: string;
  priority: number;
  /** Acceptance checks, each reading "given … when … then …". */
  acceptance?: string[];
}

/** Reads and validates a backlog.json. */
export function readBacklog(file: string): BacklogItem[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file}: a backlog is a JSON array`);
  return raw.map((item, i) => {
    const it = item as Partial<BacklogItem>;
    if (typeof it.title !== 'string' || !it.title.trim()) throw new Error(`${file}[${i}]: title is required`);
    if (typeof it.description !== 'string') throw new Error(`${file}[${i}]: description is required`);
    if (!Number.isInteger(it.priority) || it.priority! < 0 || it.priority! > 4) {
      throw new Error(`${file}[${i}]: priority is 0 to 4`);
    }
    if (it.acceptance !== undefined && !(Array.isArray(it.acceptance) && it.acceptance.every(a => typeof a === 'string'))) {
      throw new Error(`${file}[${i}]: acceptance is a list of "given … when … then …" strings`);
    }
    return it as BacklogItem;
  });
}

export interface KshetraTasks {
  /** Files the items as the system role, in order; returns their ids. */
  file(items: BacklogItem[]): Promise<string[]>;
  /** Each task's lifecycle state (open, claimed, waiting, blocked, done, cancelled, …). */
  states(ids: string[]): Promise<Map<string, string>>;
  close(): Promise<void>;
}

/** Opens the project of the Kshetra whose config is at `configPath`. */
export async function openKshetraTasks(configPath: string): Promise<KshetraTasks> {
  const config = loadKshetraConfig(configPath);
  if (!config.project) throw new Error(`${configPath} names no task graph project; did shreni init finish?`);
  const conn: KshetraEngine = await openKshetraEngine(config, { name: 'shreni-cert' });
  const tg = conn.shreni.tg.project(config.project);
  const system = tg.as({ id: 'shreni-cert', role: 'system' });
  return {
    async file(items) {
      const ids: string[] = [];
      for (const item of items) {
        const checks = (item.acceptance ?? []).map(parseCheck);
        const task = await system.tasks.create({ title: item.title, description: item.description, priority: item.priority });
        if (checks.length) {
          await conn.shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
            .values(checks.map((c, i) => ({
              project_id: tg.id, task_id: task.id, ...c, mode: 'auto',
              created_at: sql<Date>`now() + ${i} * interval '1 microsecond'`,
            })))
            .execute());
        }
        ids.push(task.id);
      }
      return ids;
    },
    async states(ids) {
      const rows = await tg.tasks.list({ ids });
      return new Map(rows.map(t => [t.id, t.state]));
    },
    close: () => conn.close(),
  };
}
