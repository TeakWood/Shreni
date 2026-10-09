import { describe, it, expect } from 'vitest';
import { openProcesses } from './test/postgres';
import type { TaskGraphEvent } from './types';

// Notifications across processes on real Postgres (engine spec, "Events and
// history"; testing tier: LISTEN/NOTIFY across connections).

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('events.subscribe across processes', () => {
  it('delivers another process\'s writes within a second', async () => {
    const { tg } = await openProcesses(2);
    const got: TaskGraphEvent[] = [];
    const unsubscribe = await tg(0).events.subscribe(events => { got.push(...events); });
    const t0 = Date.now();
    const a = await tg(1).as({ id: 'system', role: 'system' }).tasks.create({ title: 'a' });
    await until(() => got.some(e => e.taskId === a.id), 1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await unsubscribe();
  });

  it('given the listening connection drops, events written meanwhile are delivered after it reconnects', async () => {
    const { procs, tg } = await openProcesses(2);
    const got: TaskGraphEvent[] = [];
    const unsubscribe = await tg(0).events.subscribe(events => { got.push(...events); });
    // The listener's own connection dies, as on a network blip.
    const listeners = await procs[1].sql<{ pid: number }[]>`
      select pid from pg_stat_activity where datname = current_database() and query ilike 'listen %'`;
    expect(listeners.length).toBeGreaterThan(0);
    for (const { pid } of listeners) await procs[1].sql`select pg_terminate_backend(${pid})`;
    const sys = tg(1).as({ id: 'system', role: 'system' });
    const meanwhile = [await sys.tasks.create({ title: 'while down 1' }), await sys.tasks.create({ title: 'while down 2' })];
    await until(() => meanwhile.every(t => got.some(e => e.taskId === t.id)), 15_000);
    // In order, each once.
    const ids = got.map(e => BigInt(e.id));
    expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : 1)));
    expect(new Set(ids).size).toBe(ids.length);
    await unsubscribe();
  });
});
