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

import type { LoggedEvent, ActivityEvent } from '../sthapathi/activity-log.js';
import type { Provider } from '../agents/providers/types.js';

// The agent roles a metered run can belong to. The three executors, plus the
// interactive planner 'suthradhara' whose sessions are metered from their
// transcript (epic fnd). Mirrors AGENT_ROLES in kshetra/config.ts.
export type AgentRole = 'silpi' | 'viharapala' | 'parikshaka' | 'suthradhara';

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
  agent: AgentRole;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCallCount: number;
  // Whether the run that spent these tokens succeeded ('ok') or failed ('error').
  // Failed/discarded-retry runs still burn real tokens, so they are metered too
  // (Shreni-beads-1tg) — this field lets a consumer separate productive spend
  // from spend lost to errors. Entries written before schemaVersion 2 have no
  // `outcome`; read an absent value as 'ok' (v1 only ever recorded successes).
  outcome: 'ok' | 'error';
  // The main-loop model's context-window size for the run (epic 408/A1, part B),
  // the denominator peak_context is judged against. Additive OPTIONAL field — no
  // USAGE_SCHEMA_VERSION bump; a reader treats absent as unknown (the provider
  // surfaced no unambiguous entry, or it is a non-claude adapter). Never 0-filled.
  contextWindow?: number;
  // Monotonic ms this attempt took (epic hto / Study A3), timed at the site
  // (runner.ts) around the provider run and carried on every metered
  // finalization, ok or error — a failed session still consumed real time
  // (Shreni-beads-dt7). A run that is not metered at all (abort, spawn failure,
  // no-usage error) has no record, so no duration either. Additive
  // OPTIONAL field — no USAGE_SCHEMA_VERSION bump; entries written before dt7,
  // and producers that do not time the run (suthradhara's planning session),
  // omit it, and a reader treats absent as unknown, never as 0.
  durationMs?: number;
}

// Bump when the persisted UsageEntry shape changes in a way a consumer must
// branch on. Independent of the activity log's SCHEMA_VERSION — the two feeds
// version separately.
//   v1 → v2: added `outcome` ('ok' | 'error'); v1 entries recorded only
//            successful runs, so an absent `outcome` reads as 'ok'.
export const USAGE_SCHEMA_VERSION = 2;

// THE CANONICAL USAGE ENTRY (epic g2k). One of these is appended to
// ~/.shreni/kshetra/<id>/usage.jsonl per finalized agent run by the default
// UsageMeter, and it is the single record shape the rest of the metrics work
// builds on: the aggregator (g2k.2) sums over it, spend accounting (F5) reads
// `costUsd` from it, and the parked ledger (F4) folds it in as one entry kind.
// Decide it here once.
//
// It is the input UsageRecord plus a persistence envelope:
//   • `ts` / `schemaVersion` mirror the activity log's envelope so a consumer
//     can order entries and know which fields to expect.
//   • `costUsd` is the run's cost derived from the price table AT RECORD TIME
//     (pricing.ts) — a point-in-time snapshot, so later price changes never
//     rewrite past spend.
//   • `priced` is false when no price-table entry covered the provider/model;
//     `costUsd` is then a 0 placeholder that means "unknown", NOT a real $0.
//     (Gemini's all-zero token counts, by contrast, are `priced: true` with a
//     genuine 0 cost.)
export interface UsageEntry extends UsageRecord {
  ts: string;
  schemaVersion: number;
  costUsd: number;
  priced: boolean;
}

// COMPILE-TIME GUARD (Shreni-beads-dt7): the ledger's run_usage event is a
// PROJECTION of the UsageEntry, so every field it declares (bar its own `type`
// discriminant) must also exist on UsageEntry. Adding a field to run_usage
// without adding it to UsageRecord fails `pnpm typecheck` here, for EVERY
// producer (runner.ts and suthradhara.ts alike). Fields shared today: kshetra,
// beadId, agent, provider, model, inputTokens, outputTokens, costUsd, priced,
// outcome, contextWindow?, durationMs? (plus the ts/schemaVersion/runId envelope).
type RunUsageFieldsMissingFromEntry = Exclude<
  keyof Extract<ActivityEvent, { type: 'run_usage' }>,
  keyof UsageEntry | 'type'
>;
const _runUsageIsProjectionOfUsageEntry: [RunUsageFieldsMissingFromEntry] extends [never] ? true : never = true;
void _runUsageIsProjectionOfUsageEntry;

// Receives one record per finalized agent run. The default implementation
// persists it (defaults.ts, fileUsageMeter); an optional extension may swap in a
// meter that records or aggregates these numbers elsewhere.
export interface UsageMeter {
  record(usage: UsageRecord): void;
}

// A resolved provider+model for one run.
export interface ModelSelection {
  provider: Provider;
  model: string;
}

// Everything selectModel needs, including today's static answer as `default`.
// The core computes `default` from kshetra.yaml (agents.provider/model) and asks
// the policy; the default policy simply echoes it back, so selection is
// unchanged. An extension policy may override per bead/agent.
export interface SelectModelRequest {
  kshetra: string;
  beadId: string;
  agent: AgentRole;
  default: ModelSelection;
}

// The context for a pre-run go/no-go check.
export interface PolicyRunContext {
  kshetra: string;
  beadId: string;
  agent: AgentRole;
  provider: Provider;
  model: string;
}

// A pre-run decision. `allowed: false` carries a human-readable reason the core
// surfaces; the default policy always allows.
export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

// Owns model/provider selection and the go/no-go check only. Retry, backoff, and
// provider failover stay in the run dispatcher (runner.ts).
export interface PolicySource {
  selectModel(req: SelectModelRequest): ModelSelection;
  mayProceed(run: PolicyRunContext): PolicyDecision;
}

// Resolves capability flags and limits for optional features. The core never
// assumes a feature is on or off — it asks. The default answers with all
// locally-available features enabled and no limits. The core never validates a
// license; it only queries this seam.
export interface Entitlements {
  capability(flag: string): boolean;
  limit(key: string): number | null;
}

// The handle an extension's register(core) entry receives. It may append its own
// EventSink(s) and swap the UsageMeter / PolicySource / Entitlements. Additive
// only — an extension cannot remove the local defaults, so local behavior is
// never taken away.
export interface ExtensionCore {
  readonly version: string;
  addEventSink(sink: EventSink): void;
  setUsageMeter(meter: UsageMeter): void;
  setPolicySource(policy: PolicySource): void;
  setEntitlements(entitlements: Entitlements): void;
}

// Shape an optional extension package must export. Loaded fail-open at worker
// startup (src/ext/loader.ts).
export interface Extension {
  register(core: ExtensionCore): void | Promise<void>;
}