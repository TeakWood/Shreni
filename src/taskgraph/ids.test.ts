import { describe, it, expect, onTestFinished } from 'vitest';
import { sql } from 'kysely';
import { createMigratedTestDb, PGLITE_TIMEOUT, type TestDb } from './test/pglite';
import { newTaskId, newPlanId, nextChildId } from './ids';

const P = '00000000-0000-0000-0000-000000000001';
// n as three base-36 characters, in SQL
const A = `'0123456789abcdefghijklmnopqrstuvwxyz'`;
const B36 = `substr(${A}, n / 1296 % 36 + 1, 1) || substr(${A}, n / 36 % 36 + 1, 1) || substr(${A}, n % 36 + 1, 1)`;

async function openDb(): Promise<TestDb> {
  const t = await createMigratedTestDb();
  onTestFinished(() => t.close());
  await t.pglite.exec(`
    insert into taskgraph.lifecycles (name, version, definition, hash) values ('l', 1, '{}', 'h');
    insert into taskgraph.projects (id, name, id_prefix, lifecycle_name, lifecycle_version) values ('${P}', 'web', 'web', 'l', 1);
  `);
  return t;
}

/** Inserts a task with the drawn id, reporting whether the id was free. */
const insertTask = (t: TestDb) => async (id: string) => (await t.pglite.query(
  `insert into taskgraph.tasks (project_id, id, kind, title, state, origin) values ($1, $2, 'work', 't', 'proposed', 'manual')
   on conflict (project_id, id) do nothing returning id`, [P, id])).rows.length === 1;

const insertPlan = (t: TestDb) => async (id: string) => (await t.pglite.query(
  `insert into taskgraph.plans (project_id, id, title) values ($1, $2, 'p') on conflict (project_id, id) do nothing returning id`,
  [P, id])).rows.length === 1;

async function addTask(t: TestDb, id: string, parent: string | null = null) {
  await t.pglite.query(
    `insert into taskgraph.tasks (project_id, id, parent_id, kind, title, state, origin) values ($1, $2, $3, 'work', 't', 'proposed', 'manual')`,
    [P, id, parent],
  );
}

/** Draws from a fixed sequence of base-36 characters, then from Math.random. */
function draws(chars: string): (n: number) => number {
  let i = 0;
  return n => (i < chars.length ? parseInt(chars[i++], 36) : Math.floor(Math.random() * n));
}

describe('task ids', { timeout: PGLITE_TIMEOUT }, () => {
  it('are <id_prefix>-<three base-36 characters>', async () => {
    const t = await openDb();
    const id = await newTaskId(t.db, P, insertTask(t));
    expect(id).toMatch(/^web-[0-9a-z]{3}$/);
    expect((await t.pglite.query(`select id from taskgraph.tasks`)).rows).toEqual([{ id }]);
  });

  it('are drawn again on a collision', async () => {
    const t = await openDb();
    await addTask(t, 'web-k3x');
    expect(await newTaskId(t.db, P, insertTask(t), draws('k3xab7'))).toBe('web-ab7');
  });

  it('get a fourth character once a quarter of the three-character space is used', async () => {
    const t = await openDb();
    // 36^3 / 4 = 11664 top-level ids of three characters
    await t.pglite.exec(`
      insert into taskgraph.tasks (project_id, id, kind, title, state, origin)
      select '${P}', 'web-' || ${B36}, 'work', 't', 'proposed', 'manual'
        from generate_series(0, 11663) n`);
    expect(await newTaskId(t.db, P, insertTask(t))).toMatch(/^web-[0-9a-z]{4}$/);
  });

  it('stay at three characters just below a quarter, ignoring child ids', async () => {
    const t = await openDb();
    await t.pglite.exec(`
      insert into taskgraph.tasks (project_id, id, kind, title, state, origin)
      select '${P}', 'web-' || ${B36}, 'work', 't', 'proposed', 'manual'
        from generate_series(0, 11662) n`);
    await addTask(t, 'web-000.1', 'web-000');
    expect(await newTaskId(t.db, P, insertTask(t))).toMatch(/^web-[0-9a-z]{3}$/);
  });
});

describe('task ids, drawn by insert', { timeout: PGLITE_TIMEOUT }, () => {
  it('draw again when the insert reports the id taken, as a concurrent insert would', async () => {
    const t = await openDb();
    const tried: string[] = [];
    const id = await newTaskId(t.db, P, async id => { tried.push(id); return tried.length > 1; }, draws('aaabbb'));
    expect(tried).toEqual(['web-aaa', 'web-bbb']);
    expect(id).toBe('web-bbb');
  });
});

describe('child ids', { timeout: PGLITE_TIMEOUT }, () => {
  it('are the parent id plus .<n> from its next_child counter, never reused', async () => {
    const t = await openDb();
    await addTask(t, 'web-k3x');
    const ids = await t.db.transaction().execute(async tx => [await nextChildId(tx, P, 'web-k3x'), await nextChildId(tx, P, 'web-k3x')]);
    expect(ids).toEqual(['web-k3x.1', 'web-k3x.2']);
    // a child that moves away doesn't free its number
    await addTask(t, 'web-k3x.2', 'web-k3x');
    await t.pglite.exec(`update taskgraph.tasks set parent_id = null where id = 'web-k3x.2'`);
    expect(await t.db.transaction().execute(tx => nextChildId(tx, P, 'web-k3x'))).toBe('web-k3x.3');
    expect((await sql<{ n: number }>`select next_child as n from taskgraph.tasks where id = 'web-k3x'`.execute(t.db)).rows[0].n).toBe(4);
  });
});

describe('plan ids', { timeout: PGLITE_TIMEOUT }, () => {
  it('are <id_prefix>-plan-<short>, drawn again on a collision', async () => {
    const t = await openDb();
    await t.pglite.exec(`insert into taskgraph.plans (project_id, id, title) values ('${P}', 'web-plan-aaa', 'p')`);
    expect(await newPlanId(t.db, P, insertPlan(t), draws('aaabbb'))).toBe('web-plan-bbb');
    expect(await newPlanId(t.db, P, insertPlan(t))).toMatch(/^web-plan-[0-9a-z]{3}$/);
  });
});
