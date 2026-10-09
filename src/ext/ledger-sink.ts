// The ledger's writer (epic 4a2.3): a SECOND EventSink, beside localFileSink, in
// the same fan-out registry. It is NOT a reshape of activity.jsonl — it observes
// the same event stream and writes a DIFFERENT, git-tracked file. SinkRegistry
// already fans every event out to a list of sinks and isolates a throwing one
// (sink-registry.ts); this adds one more member to that list.
//
// What it does: filter the stream to decision-grade events (isDecisionGrade,
// 4a2.1), map each to a LedgerEntry (toLedgerEntry), and append one JSON object
// per line to ledger.jsonl at ledgerPath: the BEADS REPO (git-tracked, pushed,
// shareable), or the Kshetra's runtime dir on the task graph engine. The high-volume run-log tier (agent_text,
// agent_tool_call) never lands here; its evidence is referenced by runId into
// activity.jsonl / usage.jsonl, never inlined.
//
// activity.jsonl is untouched: this sink writes only to ledgerPath, so the local
// activity log stays byte-identical to before the ledger existed.

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { SCHEMA_VERSION, type ActivityEvent, type LoggedEvent } from '../sthapathi/activity-log.js';
import type { EventSink } from './types.js';
import { isDecisionGrade, toLedgerEntry } from './ledger.js';

// Append one decision-grade event to a ledger.jsonl, filtering + mapping exactly
// as the sink does. The single write path shared by the worker's sink and the
// direct CLI appender below.
function writeLedgerEntry(ledgerPath: string, ev: LoggedEvent): void {
  if (!isDecisionGrade(ev)) return; // run-log tier stays local, out of git
  const entry = toLedgerEntry(ev);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
}

// Append a decision-grade event to a ledger.jsonl from OUTSIDE the worker's emit
// pipeline — for CLI commands (shreni freeze / restore, epic Shreni-beads-ius)
// that record a kshetra-level decision but never run a worker/SinkRegistry. The
// envelope's ts/schemaVersion are stamped here the way emit() would; there is no
// runId/lotId (no governing run). Non-fatal by contract: callers should treat a
// throw as best-effort audit, never fail the underlying operation on it.
export function appendLedgerEvent(ledgerPath: string, ev: ActivityEvent): void {
  writeLedgerEntry(ledgerPath, {
    ...ev,
    ts: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  });
}

export interface LedgerSinkOpts {
  // The Kshetra this sink writes for. A worker process drives exactly one
  // Kshetra, so its sink observes only that Kshetra's events; this id lets the
  // sink ignore any foreign event defensively (e.g. a future multi-Kshetra
  // process registering several ledger sinks against one registry).
  kshetraId: string;
  // Absolute path to ledger.jsonl — the worker resolves it with ledgerPath
  // (kshetra/state-locations) and passes it in, so this module
  // stays decoupled from KshetraConfig.
  ledgerPath: string;
}

// Build the ledger EventSink for one Kshetra. Registered at worker startup via
// SinkRegistry.add() (extensionCore.addEventSink), beside the default
// localFileSink. It may throw (a full disk, a permissions error) — the SinkRegistry isolates it, so a failing ledger write never
// stops localFileSink from receiving the event and never crashes the worker.
export function makeLedgerSink(opts: LedgerSinkOpts): EventSink {
  const { kshetraId, ledgerPath } = opts;
  return {
    name: 'ledger',
    handle(ev: LoggedEvent): void {
      if (ev.kshetra !== kshetraId) return; // only this Kshetra's events
      writeLedgerEntry(ledgerPath, ev);
    },
  };
}
