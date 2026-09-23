import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logPath, usagePath, type LoggedEvent } from '../sthapathi/activity-log.js';
import type { EventSink, UsageMeter, UsageRecord, UsageEntry, PolicySource, Entitlements } from './types.js';
import { USAGE_SCHEMA_VERSION } from './types.js';
import { costFor } from './pricing.js';

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

// Wrap a UsageRecord in the persistence envelope (ts/schemaVersion) plus the
// price snapshot, producing the canonical UsageEntry fileUsageMeter appends.
// Every record field passes through unchanged — including optional ones like
// contextWindow and durationMs — so the entry is a superset of the record, and
// the ledger's run_usage fold (a projection of the same record) can never carry
// a field usage.jsonl lacks (Shreni-beads-dt7). Pure; exported for that test.
export function toUsageEntry(usage: UsageRecord, ts: string = new Date().toISOString()): UsageEntry {
  const { costUsd, priced } = costFor(usage);
  return {
    ...usage,
    ts,
    schemaVersion: USAGE_SCHEMA_VERSION,
    costUsd,
    priced,
  };
}

// The default UsageMeter: derive the run's cost from the price table
// (pricing.ts) and append one canonical UsageEntry to the Kshetra's usage.jsonl
// — same mkdir-then-append, one-JSON-object-per-line format as the activity log
// beside it. Everything stays on the machine (no accounting emitted off-box); it
// is the durable source the metrics aggregator (g2k.2) and spend (F5) read.
//
// Like localFileSink this may throw (a full disk, a permissions error); the
// runner's reportUsage() wraps every record() call so a metering failure never
// fails an otherwise-successful agent run.
export const fileUsageMeter: UsageMeter = {
  record(usage: UsageRecord): void {
    const entry = toUsageEntry(usage);
    const path = usagePath(usage.kshetra);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  },
};

// The prior free-tier default: drop the record on the floor. No longer the
// default (fileUsageMeter is), but kept as an explicit opt-out an extension —
// or a test — can swap back in to record nothing.
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