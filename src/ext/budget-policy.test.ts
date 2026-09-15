import { describe, it, expect, vi } from 'vitest';
import { makeBudgetPolicy } from './budget-policy.js';
import type { PolicySource, PolicyRunContext, SpendSoFar } from './index.js';
import type { BudgetConfig } from '../kshetra/config.js';

const ALLOW_ALL: PolicySource = {
  selectModel: req => req.default,
  mayProceed: () => ({ allowed: true }),
};

function run(over: Partial<PolicyRunContext> = {}): PolicyRunContext {
  return { kshetra: 'myapp', beadId: 'b-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6', ...over };
}

function spend(over: Partial<SpendSoFar> = {}): SpendSoFar {
  return { beadUsd: 0, kshetraUsd: 0, beadUnpricedRuns: 0, kshetraUnpricedRuns: 0, ...over };
}

// Build a budget policy with injected budget + spend, over an allow-all inner.
function policyWith(budget: BudgetConfig | undefined, spendSoFar: SpendSoFar, inner: PolicySource = ALLOW_ALL) {
  return makeBudgetPolicy(inner, {
    resolveBudget: () => budget,
    readSpend: () => spendSoFar,
  });
}

describe('makeBudgetPolicy', () => {
  it('allows a run when no budget block is configured (uncapped)', () => {
    const p = policyWith(undefined, spend({ beadUsd: 999 }));
    expect(p.mayProceed(run())).toEqual({ allowed: true });
  });

  it('allows a run when the budget block sets no actual cap', () => {
    const p = policyWith({}, spend({ beadUsd: 999 }));
    expect(p.mayProceed(run())).toEqual({ allowed: true });
  });

  it('allows a within-budget run', () => {
    const p = policyWith({ perBeadUsd: 5 }, spend({ beadUsd: 3 }));
    expect(p.mayProceed(run())).toEqual({ allowed: true });
  });

  it('denies once the per-bead cap is reached', () => {
    const p = policyWith({ perBeadUsd: 5 }, spend({ beadUsd: 5 }));
    const decision = p.mayProceed(run());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('per-bead budget cap');
  });

  it('denies once the per-bead cap is exceeded', () => {
    const p = policyWith({ perBeadUsd: 5 }, spend({ beadUsd: 7.5 }));
    expect(p.mayProceed(run()).allowed).toBe(false);
  });

  it('denies once the per-Kshetra cap is exceeded even if the bead is under', () => {
    const p = policyWith({ perBeadUsd: 5, perKshetraUsd: 100 }, spend({ beadUsd: 1, kshetraUsd: 100 }));
    const decision = p.mayProceed(run());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('per-Kshetra budget cap');
  });

  it('checks the per-bead cap before the per-Kshetra cap', () => {
    const p = policyWith({ perBeadUsd: 5, perKshetraUsd: 100 }, spend({ beadUsd: 5, kshetraUsd: 200 }));
    const decision = p.mayProceed(run());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('per-bead');
  });

  it('respects an inner policy denial without consulting the budget', () => {
    const denyingInner: PolicySource = {
      selectModel: req => req.default,
      mayProceed: () => ({ allowed: false, reason: 'inner gate says no' }),
    };
    const readSpend = vi.fn(() => spend());
    const p = makeBudgetPolicy(denyingInner, { resolveBudget: () => ({ perBeadUsd: 5 }), readSpend });
    const decision = p.mayProceed(run());
    expect(decision).toEqual({ allowed: false, reason: 'inner gate says no' });
    expect(readSpend).not.toHaveBeenCalled(); // short-circuits before the ledger read
  });

  it('delegates model selection to the inner policy unchanged', () => {
    const inner: PolicySource = {
      selectModel: () => ({ provider: 'openai', model: 'gpt-5-codex' }),
      mayProceed: () => ({ allowed: true }),
    };
    const p = makeBudgetPolicy(inner, { resolveBudget: () => ({ perBeadUsd: 5 }), readSpend: () => spend() });
    expect(p.selectModel({ kshetra: 'myapp', beadId: 'b-1', agent: 'silpi', default: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }))
      .toEqual({ provider: 'openai', model: 'gpt-5-codex' });
  });
});
