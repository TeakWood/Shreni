import postgres from 'postgres';
import type { KshetraConfig } from '../../kshetra/config.js';
import { loadUserConfig, resolveDatabase } from '../../kshetra/user-config.js';
import { openShreni, type ShreniClient } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { workerName } from './leases';

// Opens the database a Kshetra uses (policy spec, "The database"): the pool,
// and the session connection for the worker lock, named after this worker so
// a second worker can say whose lock it found.

export interface KshetraEngine {
  shreni: ShreniClient;
  close(): Promise<void>;
}

export async function openKshetraEngine(kshetra: KshetraConfig, opts: { name?: string } = {}): Promise<KshetraEngine> {
  const target = resolveDatabase(kshetra, loadUserConfig());
  const auth = { ...(target.user ? { username: target.user } : {}), ...(target.password ? { password: target.password } : {}) };
  const sql = postgres(target.url, { max: 4, onnotice: () => {}, ...auth });
  const session = postgres(target.url, {
    max: 1, max_lifetime: null, idle_timeout: 0, onnotice: () => {}, ...auth,
    connection: { application_name: opts.name ?? workerName() },
  });
  try {
    const shreni = await openShreni({ sql, session, lifecycle: taskLifecycle });
    return {
      shreni,
      async close() {
        await shreni.close();
        await sql.end({ timeout: 5 });
        await session.end({ timeout: 5 });
      },
    };
  } catch (err) {
    await sql.end({ timeout: 1 });
    await session.end({ timeout: 1 });
    throw err;
  }
}
