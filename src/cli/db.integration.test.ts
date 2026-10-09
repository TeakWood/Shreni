import { describe, it, expect } from 'vitest';
import { freshDatabase } from '../taskgraph/test/postgres';
import { realProbe } from './db';
import { checkDatabase } from '../policy/db/checks';

// shreni db check's probe against real Postgres: the version, a missing
// database (3D000) created through the maintenance database, and a login as a
// role that doesn't exist (28000).

describe('the database probe on real Postgres', () => {
  it('reads the version, creates a missing database, and reports a missing role', async () => {
    const url = await freshDatabase();
    const probe = realProbe();
    const target = { name: 'local', url };
    const here = await probe.connect(target);
    expect(here.ok && here.serverVersionNum).toBeGreaterThanOrEqual(150_000);

    const name = `shreni_check_${Date.now()}`;
    const missing = { name: 'local', url: url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`) };
    const before = await probe.connect(missing);
    expect(before).toMatchObject({ ok: false, code: '3D000' });
    const report = await checkDatabase(missing, { ...probe, pgDumpMajor: async () => 99 }, { interactive: false, ask: async () => '', create: true });
    expect(report.lines.map(l => l.text).join('\n')).toMatch(new RegExp(`Created the database "${name}"`));
    expect(report.ok).toBe(true);

    const nobody = await probe.connect({ name: 'local', url: url.replace(/\/\/[^@/]*@/, '//no_such_role@').replace(/^postgres(ql)?:\/\/(?![^/]*@)/, 'postgres://no_such_role@') });
    expect(nobody).toMatchObject({ ok: false });
    expect(['28000', '28P01']).toContain((nobody as { code: string }).code);
  });
});
