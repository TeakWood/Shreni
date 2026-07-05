import { describe, it, expect, vi, afterEach } from 'vitest';
import { SinkRegistry } from './sink-registry.js';
import type { EventSink } from './types.js';
import type { LoggedEvent } from '../sthapathi/activity-log.js';

const EV = { type: 'beads_synced', kshetra: 'myapp', ts: '2026-07-05T00:00:00.000Z' } as LoggedEvent;

function recordingSink(name: string, seen: string[]): EventSink {
  return { name, handle: () => { seen.push(name); } };
}

afterEach(() => vi.restoreAllMocks());

describe('SinkRegistry', () => {
  it('fans one event out to every sink, in registration order', () => {
    const seen: string[] = [];
    const reg = new SinkRegistry([recordingSink('a', seen), recordingSink('b', seen)]);
    reg.add(recordingSink('c', seen));
    reg.handle(EV);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('isolates a throwing sink — the others still receive the event', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const reg = new SinkRegistry([
      recordingSink('before', seen),
      { name: 'boom', handle: () => { throw new Error('sink exploded'); } },
      recordingSink('after', seen),
    ]);
    expect(() => reg.handle(EV)).not.toThrow();
    // A throwing sink must not stop the sinks registered after it.
    expect(seen).toEqual(['before', 'after']);
  });

  it('isolates an async-rejecting sink without throwing on the hot path', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const reg = new SinkRegistry([
      { name: 'slow-reject', handle: () => Promise.reject(new Error('later failure')) },
      recordingSink('sync-after', seen),
    ]);
    // handle() returns synchronously; a rejecting promise is fire-and-forget.
    expect(() => reg.handle(EV)).not.toThrow();
    expect(seen).toEqual(['sync-after']);
    // Let the microtask queue drain so the rejection is caught + reported once.
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it('does not await an async sink — a pending sink never blocks the caller', () => {
    let resolved = false;
    const reg = new SinkRegistry([
      { name: 'pending', handle: () => new Promise<void>(() => { /* never resolves */ }) },
    ]);
    reg.handle(EV);
    // If handle() awaited the sink, this line would never be reached.
    resolved = true;
    expect(resolved).toBe(true);
  });

  it('list() exposes the current sinks', () => {
    const seen: string[] = [];
    const reg = new SinkRegistry([recordingSink('only', seen)]);
    expect(reg.list().map(s => s.name)).toEqual(['only']);
  });
});