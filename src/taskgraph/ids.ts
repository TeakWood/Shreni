import { randomInt } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { NotFound } from './errors';

// Task and plan ids (engine spec, "Data model": task ids keep the bead shape).
// A top-level task is <id_prefix>-<short>, a plan <id_prefix>-plan-<short>, with
// `short` random base-36 characters: three, and one more each time a project
// has used a quarter of the space at the current length. A child is its
// parent's id plus .<n>, from the parent's next_child counter.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const MIN_LENGTH = 3;
const MAX_DRAWS = 20;

/** Returns an integer in [0, n); injectable so tests can force collisions. */
export type Draw = (n: number) => number;

const defaultDraw: Draw = n => randomInt(n);

function short(length: number, draw: Draw): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[draw(ALPHABET.length)];
  return s;
}

async function idPrefix(db: Kysely<any>, projectId: string): Promise<string> {
  const r = await sql<{ id_prefix: string }>`
    select id_prefix from taskgraph.projects where id = ${projectId}`.execute(db);
  if (!r.rows[0]) throw new NotFound('project', projectId);
  return r.rows[0].id_prefix;
}

/** The short length to draw at: the first whose space is less than a quarter used. */
async function shortLength(db: Kysely<any>, table: 'tasks' | 'plans', projectId: string, head: string): Promise<number> {
  // Top-level ids only: a child id has a dot after the head.
  const r = await sql<{ len: number; n: number }>`
    select length(id) - ${head.length} as len, count(*)::int as n
      from ${sql.table(`taskgraph.${table}`)}
     where project_id = ${projectId} and starts_with(id, ${head}) and strpos(substr(id, ${head.length + 1}), '.') = 0
     group by 1`.execute(db);
  const used = new Map(r.rows.map(row => [Number(row.len), row.n]));
  let length = MIN_LENGTH;
  while ((used.get(length) ?? 0) * 4 >= ALPHABET.length ** length) length++;
  return length;
}

/**
 * Inserts the row a new id names. Returns false when the id is taken, so the
 * caller's insert should use `on conflict (project_id, id) do nothing`: that
 * also catches an id another transaction is inserting right now, which no
 * read could see.
 */
export type TryInsert = (id: string) => Promise<boolean>;

async function draw(
  db: Kysely<any>, table: 'tasks' | 'plans', projectId: string, head: string, tryInsert: TryInsert, rand: Draw,
): Promise<string> {
  const length = await shortLength(db, table, projectId, head);
  for (let i = 0; i < MAX_DRAWS; i++) {
    const id = head + short(length, rand);
    if (await tryInsert(id)) return id;
  }
  // At most a quarter of the space is used, so this takes ~1 in 4^20 bad luck.
  throw new Error(`taskgraph: no free id under ${head} after ${MAX_DRAWS} draws`);
}

/** Inserts a new top-level task under a fresh id, drawing again while the id is taken; returns the id. */
export async function newTaskId(db: Kysely<any>, projectId: string, tryInsert: TryInsert, rand: Draw = defaultDraw): Promise<string> {
  return draw(db, 'tasks', projectId, `${await idPrefix(db, projectId)}-`, tryInsert, rand);
}

/** Inserts a new plan under a fresh id, drawing again while the id is taken; returns the id. */
export async function newPlanId(db: Kysely<any>, projectId: string, tryInsert: TryInsert, rand: Draw = defaultDraw): Promise<string> {
  return draw(db, 'plans', projectId, `${await idPrefix(db, projectId)}-plan-`, tryInsert, rand);
}

/**
 * The next child id under a parent, bumping its next_child counter. The update
 * locks the parent row until the transaction ends, so call it in the
 * transaction that creates the child.
 */
export async function nextChildId(tx: Kysely<any>, projectId: string, parentId: string): Promise<string> {
  const r = await sql<{ n: number }>`
    update taskgraph.tasks set next_child = next_child + 1
     where project_id = ${projectId} and id = ${parentId}
    returning next_child - 1 as n`.execute(tx);
  if (!r.rows[0]) throw new NotFound('task', parentId);
  return `${parentId}.${r.rows[0].n}`;
}
