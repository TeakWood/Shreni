import { describe, it, expect } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import {
  collectConfig,
  hashResolvedConfig,
  collectExtensionIdentity,
  collectProviders,
  collectLotManifest,
  probe,
} from './lot-manifest.js';

// A minimal resolved-shape KshetraConfig for the pure collectors. Only the fields
// the manifest reads need be present; `as unknown as KshetraConfig` mirrors the
// other sthapathi unit tests (gates.test.ts).
function ksh(over: Record<string, unknown> = {}): KshetraConfig {
  return {
    id: 'myapp',
    repo: { path: '/projects/myapp', remote: 'git@x:y.git', mainBranch: 'main' },
    beads: { path: '/projects/myapp-beads', remote: 'git@x:yb.git', mode: 'embedded' },
    agents: { provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
    gates: {
      test: { level: 'block' },
      lint: { level: 'block' },
      coverage: { level: 'warn' },
      diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
    },
    ...over,
  } as unknown as KshetraConfig;
}

describe('collectConfig — inline effective values (epic yrk / Study B2, yrk.3)', () => {
  it('inlines per-role provider/model, maxRoundsPerBead, mergePolicy, budget, gates', () => {
    const cfg = collectConfig(
      ksh({
        repo: { path: '/p', remote: 'r', mainBranch: 'main', mergePolicy: 'pr' },
        budget: { perBeadUsd: 5 },
        agents: {
          provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 4,
          silpi: { provider: 'openai', model: 'gpt-x' },
        },
      }),
    );
    expect(cfg.mergePolicy).toBe('pr');
    expect(cfg.maxRoundsPerBead).toBe(4);
    expect(cfg.budget).toEqual({ perBeadUsd: 5 });
    const roles = cfg.roles as Record<string, { provider: string; model: string }>;
    expect(roles.silpi).toEqual({ provider: 'openai', model: 'gpt-x' }); // role override
    expect(roles.viharapala).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' }); // inherits
    expect(cfg.resolvedConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('inlines active ablation switches (epic 8wi / Study B1)', () => {
    expect((collectConfig(ksh()).ablations)).toEqual([]);
    const cfg = collectConfig(ksh({ ablation: { review: 'off' } }));
    expect(cfg.ablations).toEqual(['review']);
  });

  it('records every gate as warn under enforcement ablation, changing the config hash (epic 8wi)', () => {
    const normal = collectConfig(ksh());
    const ablated = collectConfig(ksh({ ablation: { enforcement: 'off' } }));
    // Every gate is enforced at warn (including the test/lint clamp).
    expect(ablated.gates).toEqual({ test: 'warn', lint: 'warn', coverage: 'warn', diffSize: 'warn' });
    // And the enforced-config hash reflects it — an ablated config is distinct.
    expect(ablated.resolvedConfigHash).not.toBe(normal.resolvedConfigHash);
  });

  it('records the EFFECTIVE (clamped) gate level: a warn on test/lint is block', () => {
    const cfg = collectConfig(ksh({
      gates: {
        test: { level: 'warn' }, lint: { level: 'warn' },
        coverage: { level: 'warn' }, diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
      },
    }));
    const gates = cfg.gates as Record<string, string>;
    expect(gates.test).toBe('block');   // clamped
    expect(gates.lint).toBe('block');   // clamped
    expect(gates.coverage).toBe('warn');
    expect(gates.diffSize).toBe('warn');
  });
});

describe('hashResolvedConfig — canonical + clamped + redacted (yrk.3)', () => {
  it('is stable across key-order differences', () => {
    const a = ksh();
    const b = ksh();
    // Reorder b's top-level keys — canonical (sorted-key) hashing must ignore it.
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as KshetraConfig;
    expect(hashResolvedConfig(reordered)).toBe(hashResolvedConfig(a));
  });

  it('changes when an EFFECTIVE gate level changes (coverage warn→block)', () => {
    const warn = ksh();
    const block = ksh({
      gates: {
        test: { level: 'block' }, lint: { level: 'block' },
        coverage: { level: 'block' }, diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
      },
    });
    expect(hashResolvedConfig(block)).not.toBe(hashResolvedConfig(warn));
  });

  it('is UNCHANGED when test flips warn↔block — both clamp to the same effective level', () => {
    const asWarn = ksh({
      gates: {
        test: { level: 'warn' }, lint: { level: 'block' },
        coverage: { level: 'warn' }, diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
      },
    });
    const asBlock = ksh(); // test defaults to block
    expect(hashResolvedConfig(asWarn)).toBe(hashResolvedConfig(asBlock));
  });

  it('excludes credential references: differing mcp secretEnv → identical hash, and the value never appears', () => {
    const withA = ksh({ mcp: { servers: { svc: { config: 'c', secretEnv: 'TOKEN_ALPHA' } } } });
    const withB = ksh({ mcp: { servers: { svc: { config: 'c', secretEnv: 'TOKEN_BRAVO' } } } });
    expect(hashResolvedConfig(withA)).toBe(hashResolvedConfig(withB));
    // And the whole config section never carries the credential-reference value.
    const cfg = collectConfig(withA);
    expect(JSON.stringify(cfg)).not.toContain('TOKEN_ALPHA');
  });
});

describe('collectExtensionIdentity (yrk.3)', () => {
  it('reports not-loaded with all-null fields and no overrides', () => {
    expect(collectExtensionIdentity({ loaded: false, moduleId: '', seams: [] })).toEqual({
      loaded: false, path: null, contentHash: null, overrode: [],
    });
  });

  it('records the module path, content hash, and overridden seams when loaded', () => {
    // 'zod' is a real installed dep; require.resolve + hash exercise the real path.
    const id = collectExtensionIdentity({ loaded: true, moduleId: 'zod', seams: ['policySource', 'eventSink'] });
    expect(id.loaded).toBe(true);
    expect(id.path).toMatch(/zod/);
    expect(id.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.overrode).toEqual(['policySource', 'eventSink']);
  });

  it('degrades to a null path/hash (no throw) for an unresolvable module', () => {
    const id = collectExtensionIdentity({ loaded: true, moduleId: '@no/such-pkg-xyz', seams: [] });
    expect(id).toEqual({ loaded: true, path: null, contentHash: null, overrode: [] });
  });
});

describe('probe — bounded, non-fatal external version checks (yrk.3)', () => {
  it('returns the trimmed first output line on success', async () => {
    const r = await probe('node', ['--version']);
    expect(r.version).toMatch(/^v\d+/);
    expect(r.error).toBeUndefined();
  });

  it('yields null + an error string (never throws) when the binary is missing', async () => {
    const r = await probe('shreni-no-such-binary-xyz', ['--version']);
    expect(r.version).toBeNull();
    expect(typeof r.error).toBe('string');
  });
});

describe('collectProviders (yrk.3)', () => {
  it('keys one entry per distinct provider with its bin, never throwing', async () => {
    const result = await collectProviders(ksh());
    // Default config → all roles anthropic → a single 'anthropic' entry.
    expect(Object.keys(result)).toEqual(['anthropic']);
    expect(result.anthropic.bin).toBe('claude');
    // version is a string when the CLI is present, null + error when absent —
    // either way the collector completed.
    expect('version' in result.anthropic).toBe(true);
  });

  it('records an error entry (never throws) for an unknown provider', async () => {
    // A malformed config whose role names a provider with no registry entry.
    const bad = ksh({ agents: { provider: 'nope', model: 'm', maxRoundsPerBead: 3 } });
    const result = await collectProviders(bad);
    expect(result.nope.bin).toBeNull();
    expect(result.nope.version).toBeNull();
    expect(typeof result.nope.error).toBe('string');
  });
});

describe('collectLotManifest — allowAblation in process (epic 8wi)', () => {
  it('records the allowAblation flag', async () => {
    const on = await collectLotManifest(ksh(), { loaded: false, moduleId: '', seams: [] }, { allowAblation: true });
    expect((on.process as Record<string, unknown>).allowAblation).toBe(true);
    const off = await collectLotManifest(ksh(), { loaded: false, moduleId: '', seams: [] });
    expect((off.process as Record<string, unknown>).allowAblation).toBe(false);
  });
});

describe('collectLotManifest — never blocks worker start (yrk.3)', () => {
  it('returns both sections and never rejects on a malformed config', async () => {
    // A structurally-broken config (no gates) would throw inside collectSubject;
    // the top-level guard must degrade that section to {} rather than reject.
    const broken = { id: 'x', repo: { mainBranch: 'main' }, beads: { path: '/nope' }, agents: {} } as unknown as KshetraConfig;
    const sections = await collectLotManifest(broken, { loaded: false, moduleId: '', seams: [] });
    expect(sections).toHaveProperty('subject');
    expect(sections).toHaveProperty('process');
  });
});
