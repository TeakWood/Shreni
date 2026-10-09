import { describe, it, expect, onTestFinished } from 'vitest';
import postgres from 'postgres';
import { freshDatabase } from '../../taskgraph/test/postgres';
import { openShreni } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { takeWorkerLock, WorkerLockHeld } from './leases';

// One worker per Kshetra across machines (policy spec, "Running work").

async function worker(url: string, name: string) {
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  const session = postgres(url, { max: 1, max_lifetime: null, idle_timeout: 0, onnotice: () => {}, connection: { application_name: name } });
  const shreni = await openShreni({ sql, session, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close().catch(() => {}); await sql.end({ timeout: 1 }); await session.end({ timeout: 1 }); });
  return shreni;
}

describe('the worker lock', () => {
  it('a second worker for the same Kshetra refuses to start, naming the first one\'s host', async () => {
    const url = await freshDatabase();
    const a = await worker(url, 'laptop-a/111');
    await a.migrate();
    const p = await a.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'x', role: 'developer' } });
    const b = await worker(url, 'desktop-b/222');

    const held = await takeWorkerLock(a.tg.project(p.id));
    const err = await takeWorkerLock(b.tg.project(p.id)).catch(e => e);
    expect(err).toBeInstanceOf(WorkerLockHeld);
    expect(err.message).toMatch(/laptop-a\/111/);

    await held();
    expect(await takeWorkerLock(b.tg.project(p.id))).toBeTypeOf('function');
  });
});
