import { describe, it, expect } from 'vitest';
import { openProcesses } from './test/postgres';

// Session locks across processes (engine spec, "Connections"; the concurrency
// scenario "two processes take the same session lock").

describe('session locks across processes', () => {
  it('B gets nothing while A holds the worker lock, and gets it once A\'s connection is gone; A learns it lost it', async () => {
    const { procs, tg } = await openProcesses(2);
    const held = (await tg(0).locks.trySession('worker'))!;
    expect(await tg(1).locks.trySession('worker')).toBeNull();

    // A's session connection dies without A closing anything, as when its process crashes
    const [{ pid }] = await procs[0].session`select pg_backend_pid() as pid`;
    await procs[1].sql`select pg_terminate_backend(${pid})`;
    // termination is a signal: B gets the lock once A's backend has gone
    let got = null;
    for (let i = 0; i < 50 && !got; i++) {
      got = await tg(1).locks.trySession('worker');
      if (!got) await new Promise(r => setTimeout(r, 100));
    }
    expect(got).toBeTypeOf('function');
    expect(await held.held()).toBe(false);
    expect(await tg(0).locks.trySession('other')).toBeTypeOf('function'); // A's new session works
  });

  it('exactly one of two processes holds the lock, and the other gets it once the first closes', async () => {
    const { procs, tg } = await openProcesses(2);
    const results = await Promise.all([tg(0).locks.trySession('worker'), tg(1).locks.trySession('worker')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const holder = results[0] ? 0 : 1;
    await procs[holder].client.close();
    expect(await tg(1 - holder).locks.trySession('worker')).toBeTypeOf('function');
  });
});
