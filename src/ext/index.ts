// The extension core singleton: the live SinkRegistry + UsageMeter the rest of
// the core reads through, plus the ExtensionCore handle an optional extension
// registers against. Defaults preserve today's exact local behavior; the
// fail-open loader (loader.ts) may append sinks / swap the meter at worker
// startup before the Sthapathi loop arms.

import { SinkRegistry } from './sink-registry.js';
import { localFileSink, fileUsageMeter, staticPolicySource, allEnabledEntitlements } from './defaults.js';
import type { EventSink, UsageMeter, PolicySource, Entitlements, ExtensionCore } from './types.js';

export type {
  EventSink, UsageMeter, UsageRecord, UsageEntry, PolicySource, Entitlements,
  ModelSelection, SelectModelRequest, PolicyRunContext, PolicyDecision,
  AgentRole, ExtensionCore, Extension,
} from './types.js';
export { USAGE_SCHEMA_VERSION } from './types.js';
export { SinkRegistry } from './sink-registry.js';
export { localFileSink, fileUsageMeter, noopMeter, staticPolicySource, allEnabledEntitlements } from './defaults.js';
export { costFor, priceFor, BUILT_IN_PRICES, pricingOverridePath } from './pricing.js';
export type { ModelPrice, CostResult } from './pricing.js';
// Spend accounting (ho4.2): sum persisted usage into spend-so-far for a bead /
// Kshetra. Consumed by the budget mayProceed policy (ho4.3).
export { computeSpend, readUsageEntries, readSpendSoFar } from './spend.js';
export type { SpendSoFar } from './spend.js';
// Budget mayProceed policy (ho4.3): composes USD cap enforcement on top of the
// active policy. Wired at worker startup after the extension loads.
export { makeBudgetPolicy } from './budget-policy.js';
export type { BudgetPolicyDeps } from './budget-policy.js';
// The decision ledger (epic 4a2.1): envelope, decision-grade classifier,
// audience vocabulary, and the single gated read path. Pure — the sink that
// writes it (4a2.3) and the reader that renders it (4a2.6) build on these.
export {
  LEDGER_SCHEMA_VERSION, isDecisionGrade, audienceFor, readLedger,
  parseLedgerLines, toLedgerEntry,
} from './ledger.js';
export type { LedgerEntry, LedgerAudience } from './ledger.js';
// The ledgerSink (4a2.3): the second EventSink that writes decision-grade events
// to ledger.jsonl in the beads repo. Registered at worker startup beside
// localFileSink via extensionCore.addEventSink.
export { makeLedgerSink, appendLedgerEvent } from './ledger-sink.js';
export type { LedgerSinkOpts } from './ledger-sink.js';

// Default sink list = [localFileSink]; default meter = file (persists a
// UsageEntry per run to the Kshetra's usage.jsonl); default policy = static
// (today's kshetra.yaml selection, always allowed); default entitlements = all
// enabled. All mutable so the loader can extend/swap them; read only through the
// accessors below so a swapped impl is picked up by later reads.
const sinkRegistry = new SinkRegistry([localFileSink]);
let usageMeter: UsageMeter = fileUsageMeter;
let policySource: PolicySource = staticPolicySource;
let entitlements: Entitlements = allEnabledEntitlements;

// emit() publishes every event here (activity-log.ts). The registry instance is
// stable — the loader appends sinks to it rather than replacing it.
export function getSinkRegistry(): SinkRegistry {
  return sinkRegistry;
}

// runner.ts hands each finalized run's usage here. Read through the accessor so a
// meter swapped in by an extension takes effect.
export function getUsageMeter(): UsageMeter {
  return usageMeter;
}

// runner.ts routes model selection + the pre-run go/no-go check through this.
export function getPolicySource(): PolicySource {
  return policySource;
}

// The core queries this before enabling an optional feature.
export function getEntitlements(): Entitlements {
  return entitlements;
}

// Which extension seams currently differ from the local defaults (epic yrk /
// Study B2). An extension is the only thing that can change these at worker
// startup, so — called RIGHT AFTER loadExtension and BEFORE the worker registers
// its own budget policy / ledger sink — this reports exactly what the extension
// overrode. Order matters: once the worker composes makeBudgetPolicy / adds the
// ledger sink, policySource and the sink list no longer reflect the extension
// alone. The lot manifest snapshots it at that precise moment.
export function extensionSeamsSnapshot(): string[] {
  const seams: string[] = [];
  if (policySource !== staticPolicySource) seams.push('policySource');
  if (usageMeter !== fileUsageMeter) seams.push('usageMeter');
  if (entitlements !== allEnabledEntitlements) seams.push('entitlements');
  // localFileSink is the sole default; any additional sink is the extension's.
  if (sinkRegistry.list().length > 1) seams.push('eventSink');
  return seams;
}

// The handle passed to an extension's register(core). Additive: an extension may
// append sinks and swap the meter/policy/entitlements, but cannot remove the
// local defaults.
export const extensionCore: ExtensionCore = {
  version: '1',
  addEventSink(sink: EventSink): void {
    sinkRegistry.add(sink);
  },
  setUsageMeter(meter: UsageMeter): void {
    usageMeter = meter;
  },
  setPolicySource(policy: PolicySource): void {
    policySource = policy;
  },
  setEntitlements(e: Entitlements): void {
    entitlements = e;
  },
};