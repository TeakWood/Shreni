// Open/closed extension seam — interfaces (docs/architecture/extension-points.md).
//
// The core exposes a small set of extension interfaces with built-in default
// implementations. With no extension present the defaults provide today's full
// local behavior; an optional package may register its own implementations to
// observe or meter a run. This mirrors the existing ProviderAdapter seam
// (src/agents/providers/types.ts): a small interface in the core, a registry,
// and implementations supplied behind it.
//
// Only two of the four seams land here (epg.1–epg.4): the EventSink fan-out
// registry and the UsageMeter. PolicySource + Entitlements are a later step
// (epg.5) and are intentionally absent so this module stays focused on the
// behavior-preserving observation seam.

import type { LoggedEvent } from '../sthapathi/activity-log.js';

// An independent consumer of the lifecycle/activity event stream. The core holds
// an ordered list of these and fans every event out to all of them. handle() may
// be sync or async; the registry never awaits it on the hot path and isolates
// each sink so a slow or throwing consumer can never stall the Sthapathi loop.
export interface EventSink {
  readonly name: string;
  handle(ev: LoggedEvent): void | Promise<void>;
}

// Per-run token accounting handed to the UsageMeter when an agent run finalizes.
// Keyed by kshetra/beadId/runId/agent so a consumer can attribute cost to a task
// attempt without reconstructing causality. Token fields are 0 when the provider
// did not surface usage (e.g. gemini today).
export interface UsageRecord {
  kshetra: string;
  beadId: string;
  runId: string;
  agent: 'silpi' | 'viharapala' | 'parikshaka';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCallCount: number;
}

// Receives one record per finalized agent run. The default implementation is a
// no-op, so the standalone tool is unchanged; an optional extension may record
// or aggregate these numbers.
export interface UsageMeter {
  record(usage: UsageRecord): void;
}

// The handle an extension's register(core) entry receives. It may append its own
// EventSink(s) and swap the UsageMeter. Additive only — an extension cannot
// remove the local defaults, so local behavior is never taken away.
export interface ExtensionCore {
  readonly version: string;
  addEventSink(sink: EventSink): void;
  setUsageMeter(meter: UsageMeter): void;
}

// Shape an optional extension package must export. Loaded fail-open at worker
// startup (src/ext/loader.ts).
export interface Extension {
  register(core: ExtensionCore): void | Promise<void>;
}