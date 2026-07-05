import type { LoggedEvent } from '../sthapathi/activity-log.js';
import type { EventSink } from './types.js';

// Ordered fan-out registry for the event stream. Rather than a single
// replaceable handler, the core keeps a list of sinks and fans every event out
// to all of them (docs/architecture/extension-points.md). Independent observers
// attach side-by-side — the local file writer is simply the first sink in the
// default list.
//
// Fan-out is failure-isolated: each sink runs inside its own guard, so a
// throwing sink (sync) or a rejecting one (async) can never stop the other
// sinks from receiving the event, and never crashes the caller. handle() returns
// synchronously — a sink that returns a Promise is fire-and-forget, so a slow
// consumer never blocks the Sthapathi loop.
export class SinkRegistry {
  private readonly sinks: EventSink[];

  constructor(initial: EventSink[] = []) {
    this.sinks = [...initial];
  }

  add(sink: EventSink): void {
    this.sinks.push(sink);
  }

  list(): readonly EventSink[] {
    return this.sinks;
  }

  // Deliver one event to every sink. Never throws.
  handle(ev: LoggedEvent): void {
    for (const sink of this.sinks) {
      try {
        const result = sink.handle(ev);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch(err => reportSinkError(sink, err));
        }
      } catch (err) {
        reportSinkError(sink, err);
      }
    }
  }
}

// A sink failure must never crash the worker or the fan-out. Surface it once, on
// stderr, and swallow — even the reporting is guarded so a broken console can't
// re-throw into the loop.
function reportSinkError(sink: EventSink, err: unknown): void {
  try {
    console.error(`[shreni] event sink "${sink.name}" failed: ${(err as Error)?.message ?? String(err)}`);
  } catch {
    // Never let error reporting itself crash the fan-out.
  }
}