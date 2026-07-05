import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logPath, type LoggedEvent } from '../sthapathi/activity-log.js';
import type { EventSink, UsageMeter } from './types.js';

// The free-tier default EventSink: append the event to the Kshetra's
// activity.jsonl exactly as the pre-seam emit() did — same path, same
// mkdir-then-append, same one-JSON-object-per-line format. It is the first (and,
// with no extension present, only) sink in the default list, so with no
// extension loaded the on-disk activity log is byte-identical to before, save
// the new envelope fields (ts/schemaVersion/runId) that emit() now stamps.
//
// This sink may throw (a full disk, a permissions error); the SinkRegistry
// isolates it, preserving the old emit()'s "never let logging crash the worker"
// guarantee at the registry layer instead of inline.
export const localFileSink: EventSink = {
  name: 'local-file',
  handle(ev: LoggedEvent): void {
    const path = logPath(ev.kshetra);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(ev) + '\n', 'utf8');
  },
};

// The free-tier default UsageMeter: drop the record on the floor. Keeps the
// standalone tool's behavior unchanged (no accounting, nothing emitted off the
// machine). An optional extension swaps in a meter that records or aggregates.
export const noopMeter: UsageMeter = {
  record(): void {
    // intentionally does nothing
  },
};