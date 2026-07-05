// The extension core singleton: the live SinkRegistry + UsageMeter the rest of
// the core reads through, plus the ExtensionCore handle an optional extension
// registers against. Defaults preserve today's exact local behavior; the
// fail-open loader (loader.ts) may append sinks / swap the meter at worker
// startup before the Sthapathi loop arms.

import { SinkRegistry } from './sink-registry.js';
import { localFileSink, noopMeter } from './defaults.js';
import type { EventSink, UsageMeter, ExtensionCore } from './types.js';

export type { EventSink, UsageMeter, UsageRecord, ExtensionCore, Extension } from './types.js';
export { SinkRegistry } from './sink-registry.js';
export { localFileSink, noopMeter } from './defaults.js';

// Default sink list = [localFileSink]; default meter = no-op. Mutable so the
// loader can extend them; read only through the accessors below so a swapped
// meter is picked up by later reads.
const sinkRegistry = new SinkRegistry([localFileSink]);
let usageMeter: UsageMeter = noopMeter;

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

// The handle passed to an extension's register(core). Additive: an extension may
// append sinks and swap the meter, but cannot remove the local defaults.
export const extensionCore: ExtensionCore = {
  version: '1',
  addEventSink(sink: EventSink): void {
    sinkRegistry.add(sink);
  },
  setUsageMeter(meter: UsageMeter): void {
    usageMeter = meter;
  },
};