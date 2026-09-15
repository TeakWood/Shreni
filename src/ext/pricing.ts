// Cost derivation for a UsageRecord (epic g2k). A small built-in per-model price
// table maps a provider/model to per-million-token rates; costFor() turns a
// run's token counts into a USD figure. The default UsageMeter (defaults.ts)
// stamps that figure onto every persisted UsageEntry so spend (F5) reads a
// point-in-time cost — recomputing later against a changed table would rewrite
// history.
//
// Overridable in config: a user-level ~/.shreni/pricing.json merges over the
// built-ins per model, so an operator can correct a stale rate or price a model
// we don't ship a default for WITHOUT a code change. Pricing is an account-wide
// fact (what a provider charges), identical across every Kshetra, so it lives in
// the global ~/.shreni home rather than per-Kshetra kshetra.yaml.

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { UsageRecord } from './types.js';

// Per-million-token rates in USD. Cache-read/write mirror the provider's
// prompt-cache pricing (a cache hit is far cheaper than fresh input; writing an
// entry costs a small premium over input). A model that omits a cache rate is
// billed 0 for that lane.
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

// The outcome of pricing one run. `costUsd` is the total; `priced` is false when
// no table entry covered the provider/model — cost is then a 0 placeholder, NOT
// a real $0, and a consumer (F5) must treat it as "unknown", not "free".
export interface CostResult {
  costUsd: number;
  priced: boolean;
}

// Built-in table. Keyed provider → model → rates. Anthropic is the supported
// path (registry.ts marks Codex/Gemini experimental with no bakeable default
// model), so we ship confirmed Claude rates and leave the operator to price the
// model their Codex/Gemini Kshetra actually uses via the override file — the
// registry already refuses to hardcode stale ids for those providers, and the
// same reasoning applies to their prices. Rates are USD per 1M tokens.
export const BUILT_IN_PRICES: Record<string, Record<string, ModelPrice>> = {
  anthropic: {
    // Claude Sonnet 4.x — the confirmed default (registry defaultModel).
    'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    // Claude Opus 4.x — priced for a Kshetra that opts up to Opus.
    'claude-opus-4-1':   { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
    // Claude Haiku 4.x — priced for a cheap-tier Kshetra.
    'claude-haiku-4-5':  { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  },
};

// Where an operator drops per-model rate overrides.
export function pricingOverridePath(): string {
  return join(homedir(), '.shreni', 'pricing.json');
}

// Lazily-read, cached merge of the override file over the built-ins. Cached for
// the process lifetime: pricing is static config, read once per worker. A
// missing/unreadable/malformed file is ignored (fail-open to built-ins) — a bad
// override must never crash metering.
let cachedTable: Record<string, Record<string, ModelPrice>> | null = null;

function loadOverrides(): Record<string, Record<string, ModelPrice>> {
  let raw: string;
  try {
    raw = readFileSync(pricingOverridePath(), 'utf8');
  } catch {
    return {}; // no override file — the common case
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, ModelPrice>>) : {};
  } catch {
    return {}; // malformed JSON — ignore rather than crash the run
  }
}

function priceTable(): Record<string, Record<string, ModelPrice>> {
  if (cachedTable) return cachedTable;
  const overrides = loadOverrides();
  const merged: Record<string, Record<string, ModelPrice>> = {};
  for (const provider of new Set([...Object.keys(BUILT_IN_PRICES), ...Object.keys(overrides)])) {
    merged[provider] = { ...(BUILT_IN_PRICES[provider] ?? {}), ...(overrides[provider] ?? {}) };
  }
  cachedTable = merged;
  return merged;
}

// Test-only: drop the cached table so a test can point at a fresh override.
export function resetPricingCache(): void {
  cachedTable = null;
}

// Look up the rates for a provider/model, or null when the (merged) table has no
// entry — the signal that a run is unpriced.
export function priceFor(provider: string, model: string): ModelPrice | null {
  return priceTable()[provider]?.[model] ?? null;
}

// Derive the USD cost of one run from its token counts. Gemini's 0-token quirk
// falls out naturally: a run whose token fields are all 0 costs 0 even when
// priced. `priced: false` (no table entry) also yields 0, but flags it as
// unknown so a consumer never conflates it with a genuine free run.
export function costFor(usage: UsageRecord): CostResult {
  const price = priceFor(usage.provider, usage.model);
  if (!price) return { costUsd: 0, priced: false };
  const costUsd =
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok +
    (usage.cacheReadTokens / 1_000_000) * price.cacheReadPerMTok +
    (usage.cacheCreationTokens / 1_000_000) * price.cacheWritePerMTok;
  // Round to 6 decimals (micro-dollars) — enough for per-token rates, and keeps
  // the persisted number from carrying float noise into F5's spend sums.
  return { costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, priced: true };
}
