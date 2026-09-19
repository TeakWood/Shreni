// Ablation switches (epic 8wi / Study B1): remove exactly ONE orchestration
// capability at a time so E3 can attribute weight to each part of the layer.
//
// EXTENSIBILITY IS A REQUIREMENT. This module is the ONE REGISTRY: adding or
// removing a switch is a small, local, compiler-guided change here, and
// everything else derives from it — the zod schema, the AblationKey type, the
// startup banner, and (keyed off the generic `ablations` marker) shreni show
// labelling and computeMetrics exclusion. Decision sites ask isAblated(config,
// key); removing a registry entry makes every stale call site fail to compile.

import { z } from 'zod';

// THE registry. Each entry: a one-line description of the capability removed
// (shown in the startup banner) and the label used in the ledger/report.
export const ABLATIONS = {
  review: {
    description: 'review — Viharapala skipped; a round whose gates pass is approved without review',
    ledgerLabel: 'review',
  },
  enforcement: {
    description: 'enforcement — every blocking point becomes warn; gates still run and failures still surface, only enforcement is removed',
    ledgerLabel: 'enforcement',
  },
} as const;

export type AblationKey = keyof typeof ABLATIONS;

export const ABLATION_KEYS = Object.keys(ABLATIONS) as AblationKey[];

// An ablation is expressed as `<key>: 'off'` (the capability is OFF). Absent =>
// not ablated (today's behaviour). Derived from AblationKey so a config type
// change is automatic.
export type AblationConfig = Partial<Record<AblationKey, 'off'>>;

// The config-block schema, built from the registry. STRICT: an unknown key (a
// typo like `reveiw`) fails config load with a message naming the bad key AND the
// valid keys — a silent no-op would invalidate an entire study arm while the
// manifest claims the arm ran (decision 4). The only permitted value is 'off'.
export const AblationConfigSchema = z
  .record(z.string(), z.unknown())
  .superRefine((obj, ctx) => {
    for (const key of Object.keys(obj)) {
      if (!(ABLATION_KEYS as string[]).includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `unknown ablation "${key}" — valid keys: ${ABLATION_KEYS.join(', ')}`,
        });
        continue;
      }
      // Accept the string 'off' AND the YAML boolean `off` (js-yaml parses an
      // unquoted `off` as false) — an operator writing `review: off` means the
      // switch, and either form normalizes to 'off' below.
      const v = (obj as Record<string, unknown>)[key];
      if (v !== 'off' && v !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `ablation "${key}" must be "off" (its only value — the capability is removed)`,
        });
      }
    }
  })
  // Normalize every valid entry to the string 'off' so downstream code checks a
  // single canonical value regardless of quoted-vs-unquoted YAML.
  .transform(obj => {
    const out: AblationConfig = {};
    for (const key of Object.keys(obj)) out[key as AblationKey] = 'off';
    return out;
  });

// A config carrying (or omitting) an ablation block. Narrower than KshetraConfig
// on purpose — keeps this module free of a config.ts import cycle.
export interface WithAblation {
  ablation?: AblationConfig;
}

// The ONLY way code reads the block. A decision site asks by key; the compiler
// lists stale sites if a key is removed from the registry.
export function isAblated(config: WithAblation, key: AblationKey): boolean {
  return config.ablation?.[key] === 'off';
}

// The active switches for a config, in registry order. Empty when none.
export function activeAblations(config: WithAblation): AblationKey[] {
  return ABLATION_KEYS.filter(k => config.ablation?.[k] === 'off');
}

// The refusal message when a Kshetra has active ablations but --allow-ablation was
// not passed (decision 6: a copied config cannot silently weaken a real repo), or
// null when it may proceed. start / run / __worker all gate on this.
export function ablationGuardError(config: WithAblation, allowAblation: boolean): string | null {
  const active = activeAblations(config);
  if (active.length === 0 || allowAblation) return null;
  return (
    `Refusing to run: active ablation(s) weaken the harness — ${active.join(', ')}.\n` +
    active.map(k => `  • ${ABLATIONS[k].description}`).join('\n') +
    `\nPass --allow-ablation to run anyway (it is recorded in the lot manifest).`
  );
}

// The startup banner lines for the active switches (one per switch), or [] when
// none. Iterates the registry — no per-switch code.
export function ablationBanner(config: WithAblation): string[] {
  return activeAblations(config).map(k => `ABLATION ACTIVE: ${ABLATIONS[k].description}`);
}
