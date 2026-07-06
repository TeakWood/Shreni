import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logPath, type LoggedEvent } from '../sthapathi/activity-log.js';
import type { EventSink, UsageMeter, PolicySource, Entitlements } from './types.js';

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

// The free-tier default PolicySource: selection is exactly today's static answer
// (the model/provider from kshetra.yaml, passed in as `req.default`), and every
// run is allowed. An optional extension swaps in a policy that may route model
// choice per bead or gate a run.
export const staticPolicySource: PolicySource = {
  selectModel: req => req.default,
  mayProceed: () => ({ allowed: true }),
};

// The free-tier default Entitlements: every capability enabled, no limits. The
// standalone tool has all locally-available features on. An optional extension
// swaps in a resolver that may restrict them.
export const allEnabledEntitlements: Entitlements = {
  capability: () => true,
  limit: () => null,
};