import postgres from 'postgres';
import type { ProjectConfig } from '../../kshetra/project-config.js';
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

/** Opens the database a project's config names: a Kshetra's, or a tracker's for shreni task. */
export async function openKshetraEngine(
  kshetra: Pick<ProjectConfig, 'database'>, opts: { name?: string; connectTimeout?: number } = {},
): Promise<KshetraEngine> {
  const target = resolveDatabase(kshetra, loadUserConfig());
  const auth = {
    ...(target.user ? { username: target.user } : {}), ...(target.password ? { password: target.password } : {}),
    ...(opts.connectTimeout ? { connect_timeout: opts.connectTimeout } : {}),
  };
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
        // Every part is closed, even when one fails, so nothing keeps the process alive.
        const results = await Promise.allSettled([shreni.close()]);
        results.push(...await Promise.allSettled([sql.end({ timeout: 5 }), session.end({ timeout: 5 })]));
        const failed = results.find((x): x is PromiseRejectedResult => x.status === 'rejected');
        if (failed) throw failed.reason;
      },
    };
  } catch (err) {
    await sql.end({ timeout: 1 });
    await session.end({ timeout: 1 });
    throw err;
  }
}
