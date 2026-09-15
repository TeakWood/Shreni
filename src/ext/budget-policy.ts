// Budget mayProceed policy (epic ho4.3). Enforces the per-bead / per-Kshetra USD
// caps declared in kshetra.yaml (ho4.1, BudgetConfig) against spend-so-far read
// from the persisted usage ledger (ho4.2, readSpendSoFar). A run that would push a
// bead or the Kshetra at/over its cap is denied at the pre-run go/no-go check, so
// runner.ts raises RunNotPermittedError before the agent spawns — a hard-stop, not
// an after-the-fact overspend.
//
// COMPOSES on top of the currently-active policy rather than replacing it: model
// selection is delegated unchanged, and the inner policy's mayProceed denial still
// wins (budget only ever ADDS a reason to stop, never overrides an inner allow into
// a permit). Wired at worker startup AFTER the optional extension loads, so a
// swapped-in extension policy keeps its selection/gate while the kshetra.yaml
// budget caps remain enforced on top.

import type {
  PolicySource, PolicyRunContext, PolicyDecision, SelectModelRequest, ModelSelection,
} from './types.js';
import type { BudgetConfig } from '../kshetra/config.js';
import { loadRegistry } from '../kshetra/registry.js';
import { readSpendSoFar, type SpendSoFar } from './spend.js';

// Injectable seams so the policy is unit-testable without touching the registry
// file or the usage ledger on disk. Production uses the real resolvers.
export interface BudgetPolicyDeps {
  // Resolve a Kshetra's budget caps from its id (default: the registry).
  resolveBudget?: (kshetraId: string) => BudgetConfig | undefined;
  // Read spend-so-far for a bead + Kshetra (default: the usage ledger).
  readSpend?: (kshetraId: string, beadId: string) => SpendSoFar;
}

function defaultResolveBudget(kshetraId: string): BudgetConfig | undefined {
  return loadRegistry().find(k => k.id === kshetraId)?.budget;
}

// True when the block sets no actual cap — treated as uncapped (no check).
function isUncapped(budget: BudgetConfig | undefined): boolean {
  return !budget || (budget.perBeadUsd === undefined && budget.perKshetraUsd === undefined);
}

export function makeBudgetPolicy(inner: PolicySource, deps: BudgetPolicyDeps = {}): PolicySource {
  const resolveBudget = deps.resolveBudget ?? defaultResolveBudget;
  const readSpend = deps.readSpend ?? readSpendSoFar;

  return {
    selectModel: (req: SelectModelRequest): ModelSelection => inner.selectModel(req),

    mayProceed: (run: PolicyRunContext): PolicyDecision => {
      // Honor the inner policy first — an extension's own gate (or the static
      // always-allow default) decides before budget adds its cap.
      const innerDecision = inner.mayProceed(run);
      if (!innerDecision.allowed) return innerDecision;

      const budget = resolveBudget(run.kshetra);
      if (isUncapped(budget)) return { allowed: true };
      const caps = budget as BudgetConfig; // isUncapped guarantees it's defined + capped

      // spend-so-far is what's ALREADY recorded before this run; deny once it is at
      // or over a cap so the next run can't push further past it. (An unpriced run
      // contributes $0, so a ledger with unpriced runs is a lower bound — the cap
      // is enforced on known spend.)
      const spend = readSpend(run.kshetra, run.beadId);
      if (caps.perBeadUsd !== undefined && spend.beadUsd >= caps.perBeadUsd) {
        return {
          allowed: false,
          reason: `bead ${run.beadId} has spent $${spend.beadUsd} of its $${caps.perBeadUsd} per-bead budget cap`,
        };
      }
      if (caps.perKshetraUsd !== undefined && spend.kshetraUsd >= caps.perKshetraUsd) {
        return {
          allowed: false,
          reason: `Kshetra ${run.kshetra} has spent $${spend.kshetraUsd} of its $${caps.perKshetraUsd} per-Kshetra budget cap`,
        };
      }
      return { allowed: true };
    },
  };
}
