// The extension core singleton: the live SinkRegistry + UsageMeter the rest of
// the core reads through, plus the ExtensionCore handle an optional extension
// registers against. Defaults preserve today's exact local behavior; the
// fail-open loader (loader.ts) may append sinks / swap the meter at worker
// startup before the Sthapathi loop arms.

import { SinkRegistry } from './sink-registry.js';
import { localFileSink, noopMeter, staticPolicySource, allEnabledEntitlements } from './defaults.js';
import type { EventSink, UsageMeter, PolicySource, Entitlements, ExtensionCore } from './types.js';

export type {
  EventSink, UsageMeter, UsageRecord, PolicySource, Entitlements,
  ModelSelection, SelectModelRequest, PolicyRunContext, PolicyDecision,
  AgentRole, ExtensionCore, Extension,
} from './types.js';
export { SinkRegistry } from './sink-registry.js';
export { localFileSink, noopMeter, staticPolicySource, allEnabledEntitlements } from './defaults.js';

// Default sink list = [localFileSink]; default meter = no-op; default policy =
// static (today's kshetra.yaml selection, always allowed); default entitlements =
// all enabled. All mutable so the loader can extend/swap them; read only through
// the accessors below so a swapped impl is picked up by later reads.
const sinkRegistry = new SinkRegistry([localFileSink]);
let usageMeter: UsageMeter = noopMeter;
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