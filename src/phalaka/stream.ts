import {
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  watch,
  type FSWatcher,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { FastifyInstance } from 'fastify';
import { loadRegistry } from '../kshetra/registry.js';
import { logPath } from '../sthapathi/activity-log.js';
import { readProcessSnapshots, type ProcessSnapshot } from './process-read.js';
import { ProcessSnapshotSchema, requireToken } from './api.js';

// SSE change stream for the Phalaka control plane (observe-only, ADR §4.1).
//
// Phalaka is a *separate OS process* from the workers and shares no memory with
// them, so it learns of change by watching the files the fleet already writes —
// not by an IPC broker (NG2). This module tails `activity.jsonl` (new bytes
// only), watches `state.json`, and runs a ~2s liveness poll that diffs
// successive process snapshots, normalizing all three into SSE events fanned out
// to every connected client:
//
//   event: activity   → one new activity.jsonl line (raw LoggedEvent)
//   event: state      → state.json changed (raw { kshetras } — task-board banners)
//   event: process    → one ProcessSnapshot whose derived status changed; the
//                        client upserts by kind+kshetraId. A `dead` status means
//                        the process crashed or its pidfile vanished.
//   event: keepalive  → periodic ping so a dead stream is detectable client-side.
//
// **Files are truth; the watch/poll is only a doorbell.** `fs.watch` is a
// latency optimisation that just nudges a refresh; correctness never depends on
// it (it is flaky on macOS renames — ADR §4.1), because the 2s poll re-drains
// activity, re-checks state, and re-diffs liveness on its own. If `fs.watch`
// reliability bites, the socket-doorbell option (ADR §4.1 B) slots in behind the
// same refresh() entry point without touching the event model.
//
// The liveness poll deliberately uses readProcessSnapshots (file-only, no `bd`):
// the bead-derived enrichment (activeBead/queueDepth) that /api/processes merges
// via assembleKshetraStatus is left out here so a 2s poller never shells out to
// `bd`. The UI merges that enrichment from its /api/processes fetch.

export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_KEEPALIVE_MS = 15_000;

// A destination for SSE frames. The Fastify route wraps `reply.raw`; tests pass a
// collector. Kept minimal so the engine is testable without HTTP.
export interface SseSink {
  write(frame: string): void;
  end?(): void;
}

export interface ChangeStreamOptions {
  // Current set of activity.jsonl paths to tail. Re-invoked each drain so a
  // Kshetra registered after the stream started is picked up. Default: every
  // registered Kshetra's activity.jsonl.
  activityPaths?: () => string[];
  // Path to state.json (watched + polled for change). Default: ~/.shreni/state.json.
  statePath?: string;
  // File-only process snapshot source. Default: readProcessSnapshots.
  snapshot?: (now: number) => ProcessSnapshot[];
  pollMs?: number;
  keepaliveMs?: number;
  // When false, addClient does not start the real setInterval/fs.watch timers —
  // tests drive refresh()/sendKeepalive() directly for determinism.
  autoTimers?: boolean;
}

function defaultActivityPaths(): string[] {
  try {
    return loadRegistry().map(k => logPath(k.id));
  } catch {
    return [];
  }
}

function defaultStatePath(): string {
  return join(homedir(), '.shreni', 'state.json');
}

// One SSE frame. A named event + a JSON data line, terminated by a blank line.
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Identity of a process "slot": one worker / Suthradhara per Kshetra, one
// singleton Phalaka. Successive snapshots for the same slot are diffed by this
// key, so a status flip or a pid change (restart) surfaces as one `process` event.
function keyOf(s: ProcessSnapshot): string {
  return `${s.kind}:${s.kshetraId ?? ''}`;
}

// Whether a snapshot changed in a way worth pushing. Excludes heartbeatAgeMs and
// lastProgressAt — those tick every poll and would fire an event every 2s.
function processChanged(a: ProcessSnapshot, b: ProcessSnapshot): boolean {
  return (
    a.status !== b.status ||
    a.phase !== b.phase ||
    a.paused !== b.paused ||
    a.pid !== b.pid ||
    JSON.stringify(a.stuck) !== JSON.stringify(b.stuck)
  );
}

export class PhalakaChangeStream {
  private readonly activityPaths: () => string[];
  private readonly statePath: string;
  private readonly snapshot: (now: number) => ProcessSnapshot[];
  private readonly pollMs: number;
  private readonly keepaliveMs: number;
  private readonly autoTimers: boolean;

  private readonly clients = new Map<number, SseSink>();
  private counter = 0;

  // Diff state for the liveness poll, seeded by prime().
  private readonly last = new Map<string, ProcessSnapshot>();
  // Per-activity-file read offset + partial-line carry.
  private readonly offsets = new Map<string, number>();
  private readonly partials = new Map<string, string>();
  // Raw state.json content, compared verbatim so any write emits (mtime can
  // collide within a millisecond on fast writers).
  private lastStateRaw: string | null = null;
  private seeded = false;

  private pollTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];

  constructor(opts: ChangeStreamOptions = {}) {
    this.activityPaths = opts.activityPaths ?? defaultActivityPaths;
    this.statePath = opts.statePath ?? defaultStatePath();
    this.snapshot = opts.snapshot ?? readProcessSnapshots;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.autoTimers = opts.autoTimers ?? true;
  }

  // Capture the current baseline WITHOUT emitting: activity offsets jump to
  // end-of-file (tail new bytes only, never replay history), the process diff map
  // and the state signature are filled. Idempotent; called on the first client.
  prime(now: number = Date.now()): void {
    if (this.seeded) return;
    for (const path of this.activityPaths()) {
      this.offsets.set(path, this.sizeOf(path));
    }
    for (const snap of this.snapshot(now)) {
      this.last.set(keyOf(snap), snap);
    }
    this.lastStateRaw = this.readStateRaw();
    this.seeded = true;
  }

  // Register a client, send it the initial full snapshot (every process + the
  // current state + a keepalive), and start the timers on the first client.
  addClient(sink: SseSink, now: number = Date.now()): number {
    this.prime(now);
    const id = ++this.counter;
    this.clients.set(id, sink);

    for (const snap of this.last.values()) this.sendTo(sink, 'process', snap);
    const state = this.parseState(this.lastStateRaw);
    if (state !== null) this.sendTo(sink, 'state', state);
    this.sendTo(sink, 'keepalive', { t: new Date(now).toISOString() });

    if (this.autoTimers) this.startTimers();
    return id;
  }

  // Unregister a client and end its response; stop the timers when the last one
  // leaves so an idle Phalaka does no background work.
  removeClient(id: number): void {
    const sink = this.clients.get(id);
    if (!sink) return;
    this.clients.delete(id);
    try {
      sink.end?.();
    } catch {
      // a client already gone is not our problem
    }
    if (this.clients.size === 0) this.stopTimers();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // The unified refresh tick (also the fs.watch doorbell target): re-drain
  // activity, re-check state, re-diff liveness. Correctness lives here, not in
  // fs.watch — the 2s interval alone is sufficient.
  refresh(now: number = Date.now()): void {
    this.drainActivity();
    this.maybeEmitState();
    this.pollProcesses(now);
  }

  // Tail every activity.jsonl: read the bytes past our offset, split into whole
  // lines (carrying a partial across ticks), emit one `activity` per parsed line.
  drainActivity(): void {
    for (const path of this.activityPaths()) {
      const size = this.sizeOf(path);
      if (size < 0) continue; // missing file
      let offset = this.offsets.get(path);
      if (offset === undefined) {
        // First sight of this path (e.g. a Kshetra registered mid-stream): start
        // at EOF so we tail new appends, not the whole existing log.
        this.offsets.set(path, size);
        continue;
      }
      if (size < offset) {
        // Truncated or rotated — restart from the top.
        offset = 0;
        this.partials.set(path, '');
      }
      if (size === offset) continue;

      let chunk: string;
      try {
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          chunk = buf.toString('utf8');
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      this.offsets.set(path, size);

      const lines = ((this.partials.get(path) ?? '') + chunk).split('\n');
      this.partials.set(path, lines.pop() ?? ''); // trailing partial (or '')
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // a half-written or corrupt line never breaks the stream
        }
        this.broadcast('activity', event);
      }
    }
  }

  // Emit a `state` event when state.json's content changes (raw compare — see
  // lastStateRaw). The task board reads phase/paused/stuck banners from it.
  maybeEmitState(): void {
    const raw = this.readStateRaw();
    if (raw === this.lastStateRaw) return;
    this.lastStateRaw = raw;
    const state = this.parseState(raw);
    if (state !== null) this.broadcast('state', state);
  }

  // Recompute the file-only process snapshot and emit a `process` event for each
  // slot that is new or changed. A slot that vanished (pidfile removed) is emitted
  // once as `dead` — this is how the poller reports a pid that simply disappeared,
  // alongside readProcessSnapshots' own working→dead flip for a lingering pidfile.
  pollProcesses(now: number = Date.now()): void {
    const snaps = this.snapshot(now);
    const seen = new Set<string>();
    for (const snap of snaps) {
      const key = keyOf(snap);
      seen.add(key);
      const prev = this.last.get(key);
      if (!prev || processChanged(prev, snap)) this.broadcast('process', snap);
      this.last.set(key, snap);
    }
    for (const [key, prev] of this.last) {
      if (seen.has(key)) continue;
      if (prev.status !== 'dead') {
        this.broadcast('process', { ...prev, status: 'dead' });
      }
      this.last.delete(key);
    }
  }

  // Broadcast a keepalive to every client. A drained stream shows up client-side
  // as a missing ping.
  sendKeepalive(now: number = Date.now()): void {
    this.broadcast('keepalive', { t: new Date(now).toISOString() });
  }

  // Tear everything down: stop timers, close watchers, end every client. Safe to
  // call more than once (server shutdown).
  close(): void {
    this.stopTimers();
    for (const id of [...this.clients.keys()]) this.removeClient(id);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private startTimers(): void {
    if (this.pollTimer) return; // already running
    this.pollTimer = setInterval(() => this.refresh(), this.pollMs);
    this.pollTimer.unref?.();
    this.keepaliveTimer = setInterval(() => this.sendKeepalive(), this.keepaliveMs);
    this.keepaliveTimer.unref?.();
    this.startWatchers();
  }

  private stopTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // watcher already gone
      }
    }
    this.watchers = [];
  }

  // Best-effort fs.watch doorbells on the containing directories (more reliable
  // than watching a file across rename/rotate). Each just nudges refresh(); if a
  // watch cannot be established the 2s poll still covers it.
  private startWatchers(): void {
    const dirs = new Set<string>();
    dirs.add(dirname(this.statePath));
    for (const path of this.activityPaths()) dirs.add(dirname(path));
    for (const dir of dirs) {
      try {
        const w = watch(dir, () => this.refresh());
        w.unref?.();
        w.on('error', () => {
          /* a flaky watch must never crash Phalaka; the poll is the backstop */
        });
        this.watchers.push(w);
      } catch {
        // dir may not exist yet; the poll covers it
      }
    }
  }

  private broadcast(event: string, data: unknown): void {
    const frame = formatSse(event, data);
    for (const sink of this.clients.values()) {
      try {
        sink.write(frame);
      } catch {
        // a wedged client must not stall the fan-out; its close handler reaps it
      }
    }
  }

  private sendTo(sink: SseSink, event: string, data: unknown): void {
    try {
      sink.write(formatSse(event, data));
    } catch {
      // see broadcast
    }
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return -1;
    }
  }

  private readStateRaw(): string | null {
    try {
      return readFileSync(this.statePath, 'utf8');
    } catch {
      return null;
    }
  }

  private parseState(raw: string | null): unknown {
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null; // a partially-written state.json is skipped, not fatal
    }
  }
}

// Wire GET /api/stream onto the Fastify app. Gated by the same shared token as
// every other /api/* route. Uses the raw response for the long-lived SSE
// connection and hijacks the reply so Fastify does not try to serialise its own.
export function registerPhalakaStream(app: FastifyInstance, stream: PhalakaChangeStream): void {
  app.get('/api/stream', (req, reply) => {
    if (!requireToken(req, reply)) return;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeat proxy buffering so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const sink: SseSink = {
      write: (frame: string) => {
        try {
          reply.raw.write(frame);
        } catch {
          // socket gone; the close handler reaps the client
        }
      },
      end: () => {
        try {
          reply.raw.end();
        } catch {
          // already closed
        }
      },
    };

    const id = stream.addClient(sink);
    req.raw.on('close', () => stream.removeClient(id));
    reply.hijack();
  });
}

// Re-exported for consumers/tests that validate `process` event payloads against
// the same schema /api/processes serves.
export { ProcessSnapshotSchema };
