// Spend accounting (epic ho4.2). Sums persisted per-run cost (usage.jsonl, g2k.1)
// into "spend-so-far" for a single bead and for the whole Kshetra. The budget
// mayProceed policy (ho4.3) calls this before an agent spawns to enforce the
// per-bead / per-Kshetra USD caps declared in kshetra.yaml (ho4.1, BudgetConfig).
//
// Split like the metrics aggregator (metrics.ts pure + report.ts IO): computeSpend
// is PURE so it is unit-testable against fixture arrays, and readSpendSoFar wraps
// it with the file read. Kept out of cli/ so the worker/policy can call it without
// depending on the CLI layer.

import { readFileSync } from 'fs';
import { usagePath } from '../sthapathi/activity-log.js';
import type { UsageEntry } from './types.js';

export interface SpendSoFar {
  // Summed costUsd for the requested bead.
  beadUsd: number;
  // Summed costUsd across every entry in the Kshetra's ledger.
  kshetraUsd: number;
  // Runs whose model had no price entry (costUsd is a 0 placeholder there). A
  // non-zero count marks the corresponding sum as a LOWER BOUND, not exact — a
  // consumer enforcing a cap should treat "unpriced runs present" as "spend may be
  // higher than reported".
  beadUnpricedRuns: number;
  kshetraUnpricedRuns: number;
}

// Micro-dollar rounding, matching pricing.ts / metrics.ts — keeps summed spend
// free of floating-point drift.
function roundCost(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// PURE: sum spend for `beadId` and for the whole Kshetra from already-parsed usage
// entries. Reads the point-in-time `costUsd` snapshot each entry recorded (pricing
// at record time), so it never re-prices against a changed table. Failed runs
// ('error' outcome) are included — they burned real tokens (Shreni-beads-1tg), so
// their cost counts against the budget.
export function computeSpend(entries: UsageEntry[], beadId: string): SpendSoFar {
  let beadUsd = 0;
  let kshetraUsd = 0;
  let beadUnpricedRuns = 0;
  let kshetraUnpricedRuns = 0;

  for (const e of entries) {
    kshetraUsd += e.costUsd;
    if (!e.priced) kshetraUnpricedRuns++;
    if (e.beadId === beadId) {
      beadUsd += e.costUsd;
      if (!e.priced) beadUnpricedRuns++;
    }
  }

  return {
    beadUsd: roundCost(beadUsd),
    kshetraUsd: roundCost(kshetraUsd),
    beadUnpricedRuns,
    kshetraUnpricedRuns,
  };
}

// Read the Kshetra's usage.jsonl into typed entries. A MISSING file (ENOENT —
// nothing metered yet) yields [] = genuinely zero spend; a corrupt/half-written
// line is skipped so a partial ledger never fails the read. Any OTHER read error
// (permissions, IO) is rethrown, NOT swallowed: for a budget cap, silently
// treating an unreadable ledger as "0 spent" would fail open and let a run
// overspend — better to surface it. Mirrors report.ts's readJsonl (kept separate
// to avoid an ext -> cli layering dependency).
export function readUsageEntries(kshetraId: string): UsageEntry[] {
  let raw: string;
  try {
    raw = readFileSync(usagePath(kshetraId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // no ledger yet — nothing spent
    throw err;
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as UsageEntry);
    } catch {
      continue; // skip a corrupt line rather than fail the whole read
    }
  }
  return out;
}

// IO wrapper: read the ledger and compute spend-so-far for one bead + the Kshetra.
export function readSpendSoFar(kshetraId: string, beadId: string): SpendSoFar {
  return computeSpend(readUsageEntries(kshetraId), beadId);
}
