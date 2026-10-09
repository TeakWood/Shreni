import type { KshetraConfig } from '../kshetra/config.js';
import type { TaskGraphEvent } from '../taskgraph/index.js';
import { closeSharedReads, readerKey, subscribeTracker } from '../policy/sthapathi/reads.js';
import { invalidateProjectReads } from './beads-read.js';

// Live task views (policy spec, "Running work"; engine spec, "Events and
// history"): Phalaka follows each Kshetra's events instead of waiting out its
// cache. A batch of events drops the project's cached reads and rings the
// browser with a `tasks` frame, which re-fetches the board. The cache's TTL
// and the browser's polling fallback stay for a feed that is down.

/** How often the set of Kshetras followed is brought in line with the registry. */
export const RESYNC_MS = 30_000;

export interface TaskFeedOptions {
  /** The registered Kshetras, or null when the registry couldn't be read: that resync is skipped. */
  kshetras(): KshetraConfig[] | null;
  /** Called with a Kshetra and the tasks its new events name. */
  onChange(kshetraId: string, taskIds: string[]): void;
  subscribe?: typeof subscribeTracker;
  /** Closes the read connection a Kshetra no longer uses as configured. */
  release?: (k: KshetraConfig) => Promise<void>;
  /** The reader a Kshetra uses: by default its id, project and resolved database url. */
  keyOf?: (k: KshetraConfig) => string;
  log?(line: string): void;
  resyncMs?: number;
}

export class TaskFeed {
  /** Kshetra id:project:database → its unsubscribe, once subscribed, and the config it was made for. */
  private readonly subs = new Map<string, Promise<(() => Promise<void>) | null>>();
  private readonly configs = new Map<string, KshetraConfig>();
  /** Keys missing from the last resync: released only when missing twice in a row, so a config caught mid-edit isn't. */
  private readonly missing = new Set<string>();
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
    const list = this.o.kshetras();
    // A registry that couldn't be read says nothing about who left.
    if (!list) return;
    // A Kshetra pointed at another database or project is followed afresh; the old reader is closed.
    const keyOf = this.o.keyOf ?? readerKey;
    const want = new Map(list.filter(k => k.project).map(k => [keyOf(k), k]));
    for (const [key, sub] of this.subs) {
      if (want.has(key)) {
        this.missing.delete(key);
        continue;
      }
      if (!this.missing.has(key)) {
        this.missing.add(key);
        continue;
      }
      const old = this.configs.get(key)!;
      this.missing.delete(key);
      this.subs.delete(key);
      this.configs.delete(key);
      // Rows the old reader cached are another database's.
      invalidateProjectReads(old.project!);
      void sub.then(un => un?.()).catch(() => {}).then(() => (this.o.release ?? closeSharedReads)(old)).catch(() => {});
    }
    for (const [key, k] of want) {
      if (this.subs.has(key)) continue;
      const subscribe = this.o.subscribe ?? subscribeTracker;
      const sub = subscribe(k, events => this.changed(k, events), err => this.o.log?.(`[phalaka] ${k.id} events: ${(err as Error).message}`))
        .catch(err => {
          // Tried again on the next sync; until then the cache and polling cover it.
          this.o.log?.(`[phalaka] can't follow ${k.id}'s events: ${(err as Error).message}`);
          this.subs.delete(key);
          this.configs.delete(key);
          return null;
        });
      this.subs.set(key, sub);
      this.configs.set(key, k);
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
