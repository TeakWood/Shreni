// Lot-manifest collectors (epic yrk / Study B2, yrk.3): gather the two sections
// of worker_started — SUBJECT (what was changed: repo, beads state, resolved
// config) and PROCESS (what did the changing: Shreni build, extension, provider
// CLI versions, tools). Every field is an ALLOWLISTED value; the whole config is
// never serialised (decision 7 — it may reference credentials). Collection is
// bounded and non-fatal: each external probe has a short timeout and records
// null (+ an error string) on failure rather than blocking worker start.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { git } from './git.js';
import { getBuildIdentity, type BuildIdentity } from './build-info.js';
import { effectiveLevel, type GateLevel, type GateName } from './gates.js';
import { AGENT_ROLES, resolveAgentModel, type KshetraConfig } from '../kshetra/config.js';
import { activeAblations, isAblated } from '../kshetra/ablation.js';
import { providerBin } from '../agents/providers/registry.js';
import type { Provider } from '../agents/providers/types.js';

// A single external probe's result: the trimmed first line of output, or null +
// the first line of the error when the probe failed/timed out.
export interface ProbeResult {
  version: string | null;
  error?: string;
}

// The extension identity as observed at worker startup. `loaded` and `seams` are
// captured by the caller right after loadExtension (index.ts extensionSeamsSnapshot);
// `moduleId` is the id it tried (SHRENI_EXT or the default). This module resolves
// the on-disk path and hashes it.
export interface ExtensionIdentityInput {
  loaded: boolean;
  moduleId: string;
  seams: string[];
}

export interface ExtensionIdentity {
  loaded: boolean;
  path: string | null;
  contentHash: string | null;
  overrode: string[];
}

export interface LotManifestSections {
  subject: Record<string, unknown>;
  process: Record<string, unknown>;
}

// Per-probe timeout. Short: these run in parallel at worker start and must not
// stall it — a slow/hung CLI records an error, never blocks.
const PROBE_TIMEOUT_MS = 3_000;

const GATE_NAMES: GateName[] = ['test', 'lint', 'coverage', 'diffSize'];

// Run fn, returning null on any throw. For the git/file probes whose failure must
// degrade to "unknown", not crash the collector.
async function safe<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function safeSync<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// Run `<bin> <args>` with a hard timeout, resolving to its trimmed first output
// line or null + a one-line error. Never rejects — a failing probe is data, not
// a crash.
export function probe(bin: string, args: string[]): Promise<ProbeResult> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const msg = (err.message || String(err)).split('\n')[0];
        resolve({ version: null, error: msg });
        return;
      }
      const out = (stdout || stderr || '').toString().trim().split('\n')[0];
      resolve({ version: out || null });
    });
  });
}

// SHA-256 over canonical JSON (sorted keys, recursively) — so comment/whitespace/
// key-order differences in kshetra.yaml never move the hash.
function canonicalHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return v;
}

// Hash the RESOLVED config with the gate clamp applied (so the hash records what
// was ENFORCED, not what was written) and credential references redacted. The
// digest is stored; the config itself never is.
export function hashResolvedConfig(kshetra: KshetraConfig): string {
  const clone = structuredClone(kshetra) as KshetraConfig;
  // Record ENFORCED gate levels: apply the test/lint clamp AND the enforcement
  // ablation (epic 8wi — every gate warn), so the hash reflects what was enforced.
  const enfAblated = isAblated(kshetra, 'enforcement');
  for (const g of GATE_NAMES) {
    clone.gates[g].level = effectiveLevel(g, clone.gates[g].level, enfAblated);
  }
  // Redact credential references: an mcp server's secretEnv names the env var that
  // holds a token. The value never lives in the config, but redact the reference
  // so it never contributes to (or is inferable from) the hashed material.
  const servers = clone.mcp?.servers;
  if (servers) {
    for (const name of Object.keys(servers)) {
      if (servers[name].secretEnv) servers[name].secretEnv = '[redacted]';
    }
  }
  return canonicalHash(clone);
}

// Inline effective config values a reader needs without reversing the hash
// (decision 5). Allowlist only — never the whole config.
export function collectConfig(kshetra: KshetraConfig): Record<string, unknown> {
  const gates: Record<GateName, GateLevel> = {} as Record<GateName, GateLevel>;
  const enfAblated = isAblated(kshetra, 'enforcement');
  for (const g of GATE_NAMES) gates[g] = effectiveLevel(g, kshetra.gates[g].level, enfAblated);

  const roles: Record<string, { provider: string; model: string }> = {};
  for (const role of AGENT_ROLES) roles[role] = resolveAgentModel(kshetra, role);

  return {
    resolvedConfigHash: hashResolvedConfig(kshetra),
    mergePolicy: kshetra.repo.mergePolicy ?? null,
    maxRoundsPerBead: kshetra.agents.maxRoundsPerBead,
    gates,
    // The coverage threshold changes the gate's verdict (Shreni-beads-06z), so a
    // reader must see it beside the levels. Only when configured — manifests of
    // configs without one are unchanged.
    ...(kshetra.gates.coverage.min ? { coverageMin: kshetra.gates.coverage.min } : {}),
    roles,
    budget: kshetra.budget ?? null,
    // Active ablation switches (epic 8wi / Study B1). Also in the resolved-config
    // hash; inlined so a reader sees which capabilities were removed without
    // reversing the hash.
    ablations: activeAblations(kshetra),
  };
}

// beads state today: the beads repo HEAD + the last Dolt commit recorded in
// export-state.json at the beads repo root. B4 (freeze/restore) will add a tag.
async function collectBeads(kshetra: KshetraConfig): Promise<Record<string, unknown>> {
  const headSha = await safe(() => git(kshetra.beads.path).headSha());
  const lastDoltCommit = safeSync(() => {
    const raw = readFileSync(join(kshetra.beads.path, 'export-state.json'), 'utf8');
    const parsed = JSON.parse(raw) as { last_dolt_commit?: unknown };
    return typeof parsed.last_dolt_commit === 'string' ? parsed.last_dolt_commit : null;
  });
  return { headSha, lastDoltCommit };
}

async function collectSubject(kshetra: KshetraConfig): Promise<Record<string, unknown>> {
  const repoGit = git(kshetra);
  const mainBranch = kshetra.repo.mainBranch;
  const [baseSha, clean, beads] = await Promise.all([
    safe(() => repoGit.headSha(mainBranch)),
    safe(async () => {
      const s = await repoGit.status();
      return s.modified.length === 0 && s.staged.length === 0 && s.untracked.length === 0;
    }),
    collectBeads(kshetra),
  ]);
  return {
    repo: { mainBranch, baseSha, clean },
    beads,
    config: collectConfig(kshetra),
  };
}

// Resolve + hash the loaded extension module file. Not-loaded → an all-null shape
// with no overrides. Path resolution / hashing degrade to null, never throw.
export function collectExtensionIdentity(ext: ExtensionIdentityInput): ExtensionIdentity {
  if (!ext.loaded) return { loaded: false, path: null, contentHash: null, overrode: [] };
  const path = safeSync(() => require.resolve(ext.moduleId));
  const contentHash = path
    ? safeSync(() => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex'))
    : null;
  return { loaded: true, path: path ?? null, contentHash, overrode: ext.seams };
}

// One --version probe per DISTINCT provider used by any role, keyed by provider
// name. A provider whose CLI is missing/slow records null + error but never
// blocks. Runs all probes in parallel.
export async function collectProviders(
  kshetra: KshetraConfig,
): Promise<Record<string, { bin: string | null } & ProbeResult>> {
  const providers = new Set<Provider>();
  for (const role of AGENT_ROLES) providers.add(resolveAgentModel(kshetra, role).provider);

  const entries = await Promise.all(
    [...providers].map(async provider => {
      // Non-fatal per provider: providerBin throws for an unknown provider (a
      // malformed config), and probe never rejects — either way the collector
      // records an error entry rather than failing worker start (yrk.3).
      try {
        const bin = providerBin(provider);
        const result = await probe(bin, ['--version']);
        return [provider, { bin, ...result }] as const;
      } catch (err) {
        const msg = ((err as Error)?.message || String(err)).split('\n')[0];
        return [String(provider), { bin: null, version: null, error: msg }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function collectProcess(
  kshetra: KshetraConfig,
  ext: ExtensionIdentityInput,
  opts: LotManifestOpts,
): Promise<Record<string, unknown>> {
  const [providers, bd] = await Promise.all([
    collectProviders(kshetra),
    probe('bd', ['--version']),
  ]);
  return {
    shreni: getBuildIdentity() as BuildIdentity,
    extension: collectExtensionIdentity(ext),
    providers,
    tools: { bd, node: process.version },
    // Whether --allow-ablation was passed (epic 8wi / Study B1) — recorded so an
    // audit sees the flag that let an ablated Kshetra run.
    allowAblation: opts.allowAblation ?? false,
  };
}

// Invocation facts for the manifest that are not config- or repo-derived.
export interface LotManifestOpts {
  allowAblation?: boolean;
}

// Collect both manifest sections. Subject and process are gathered concurrently;
// the whole thing is bounded by PROBE_TIMEOUT_MS across parallel probes. NEVER
// rejects (decision: collection must not block worker start) — a section whose
// collection throws unexpectedly degrades to {} rather than failing the emit, so
// worker_started (and the lotId it mints) is always recorded.
export async function collectLotManifest(
  kshetra: KshetraConfig,
  ext: ExtensionIdentityInput,
  opts: LotManifestOpts = {},
): Promise<LotManifestSections> {
  const [subject, proc] = await Promise.all([
    safe(() => collectSubject(kshetra)),
    safe(() => collectProcess(kshetra, ext, opts)),
  ]);
  return { subject: subject ?? {}, process: proc ?? {} };
}
