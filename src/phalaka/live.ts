import type { KshetraConfig } from '../kshetra/config.js';
import type { TaskGraphEvent } from '../taskgraph/index.js';
import { subscribeTracker } from '../policy/sthapathi/reads.js';
import { invalidateProjectReads } from './beads-read.js';

// Live task views (policy spec, "Running work"; engine spec, "Events and
// history"): Phalaka follows each Kshetra's events instead of waiting out its
// cache. A batch of events drops the project's cached reads and rings the
// browser with a `tasks` frame, which re-fetches the board. The cache's TTL
// and the browser's polling fallback stay for a feed that is down.

/** How often the set of Kshetras followed is brought in line with the registry. */
export const RESYNC_MS = 30_000;

export interface TaskFeedOptions {
  kshetras(): KshetraConfig[];
  /** Called with a Kshetra and the tasks its new events name. */
  onChange(kshetraId: string, taskIds: string[]): void;
  subscribe?: typeof subscribeTracker;
  log?(line: string): void;
  resyncMs?: number;
}

export class TaskFeed {
  /** Kshetra id:project → its unsubscribe, once subscribed. */
  private readonly subs = new Map<string, Promise<(() => Promise<void>) | null>>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly o: TaskFeedOptions) {}

  start(): void {
    this.sync();
    this.timer = setInterval(() => this.sync(), this.o.resyncMs ?? RESYNC_MS);
    this.timer.unref?.();
  }

  /** Follows every registered Kshetra on the engine, and stops following one that left. */
  sync(): void {
    if (this.closed) return;
    const want = new Map(this.o.kshetras().filter(k => k.project).map(k => [`${k.id}:${k.project}`, k]));
    for (const [key, sub] of this.subs) {
      if (!want.has(key)) {
        this.subs.delete(key);
        void sub.then(un => un?.()).catch(() => {});
      }
    }
    for (const [key, k] of want) {
      if (this.subs.has(key)) continue;
      const subscribe = this.o.subscribe ?? subscribeTracker;
      const sub = subscribe(k, events => this.changed(k, events), err => this.o.log?.(`[phalaka] ${k.id} events: ${(err as Error).message}`))
        .catch(err => {
          // Tried again on the next sync; until then the cache and polling cover it.
          this.o.log?.(`[phalaka] can't follow ${k.id}'s events: ${(err as Error).message}`);
          this.subs.delete(key);
          return null;
        });
      this.subs.set(key, sub);
    }
  }

  private changed(k: KshetraConfig, events: TaskGraphEvent[]): void {
    invalidateProjectReads(k.project!);
    const ids = [...new Set(events.map(e => e.taskId).filter((id): id is string => !!id))];
    this.o.onChange(k.id, ids);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const subs = [...this.subs.values()];
    this.subs.clear();
    await Promise.all(subs.map(s => s.then(un => un?.()).catch(() => {})));
  }
}
