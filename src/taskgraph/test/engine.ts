import { onTestFinished } from 'vitest';
import { createMigratedTestDb, type TestDb } from './pglite';
import { testLifecycle } from './lifecycle';
import { openTaskGraph, type ActorHandle, type ProjectHandle, type TaskGraphClient } from '../client';
import type { Lifecycle } from '../lifecycle';

export interface TestEngine {
  t: TestDb;
  client: TaskGraphClient;
  tg: ProjectHandle;
  /** The project acting as `<role>` (actor id = role). */
  as(role: string): ActorHandle;
  /** Raw rows, for assertions. */
  rows<T = any>(text: string, params?: unknown[]): Promise<T[]>;
}

/** A migrated engine with one project, `web`, on the given lifecycle; closed when the test ends. */
export async function openEngine(lifecycle: Lifecycle = testLifecycle()): Promise<TestEngine> {
  const t = await createMigratedTestDb();
  // PGlite's own LISTEN, so events.subscribe works as it does on a session connection.
  const client = await openTaskGraph({ db: t.db, lifecycle, listen: (channel, fn) => t.pglite.listen(channel, fn) });
  onTestFinished(async () => { await client.close(); await t.close(); });
  const project = await client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'ann', role: 'developer' } });
  const tg = client.project(project.id);
  return {
    t, client, tg,
    as: role => tg.as({ id: role, role }),
    rows: async (text, params) => (await t.pglite.query<any>(text, params as any[])).rows,
  };
}
