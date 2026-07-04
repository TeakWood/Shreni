import type { Provider } from './types.js';
import { resolveBin } from './types.js';

// The §3.0 provider mapping table (the agent-execution design). One place that maps a
// provider to the file its CLI natively loads, the bin (+ override env), and its
// default model. Consumed by init selection/preflight (sw8.1), native execution
// (sw8.6), the instruction-file write (sw8.5), and the review-guide @import (sw8.7).

export interface ProviderInfo {
  // The CLI-facing name the operator types at init (`--provider <cliName>`).
  // Distinct from the internal Provider enum: claude->anthropic, codex->openai.
  cliName: string;
  // The instruction file the provider's CLI auto-loads from the repo root.
  instructionFile: string;
  // Bin resolution: env override var + the PATH default (fed to resolveBin).
  binEnvVar: string;
  defaultBin: string;
  // Default model, or null when the provider has no stable default we can bake
  // in — the caller must supply agents.model explicitly (OQ1). Codex/Gemini
  // model ids change often, so we refuse to hardcode a stale id.
  defaultModel: string | null;
  // Shown by the init preflight when the CLI is missing: how to install it and
  // where to read more (§3.5 hard gate).
  installCmd: string;
  docsUrl: string;
}

export const PROVIDER_REGISTRY: Record<Provider, ProviderInfo> = {
  anthropic: {
    cliName: 'claude',
    instructionFile: 'CLAUDE.md',
    binEnvVar: 'SHRENI_CLAUDE_BIN',
    defaultBin: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
  },
  openai: {
    cliName: 'codex',
    instructionFile: 'AGENTS.md',
    binEnvVar: 'SHRENI_CODEX_BIN',
    defaultBin: 'codex',
    // OQ1: unconfirmed — require agents.model on select.
    defaultModel: null,
    installCmd: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  gemini: {
    cliName: 'gemini',
    instructionFile: 'GEMINI.md',
    binEnvVar: 'SHRENI_GEMINI_BIN',
    defaultBin: 'gemini',
    // OQ1: unconfirmed — require agents.model on select.
    defaultModel: null,
    installCmd: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
};

// CLI-facing provider names in a stable order (claude first = default).
export const PROVIDER_CLI_NAMES: string[] = Object.values(PROVIDER_REGISTRY).map(i => i.cliName);

// Resolve a CLI-facing name (claude|codex|gemini) to the internal Provider enum.
// Throws with the valid set on an unknown name — the init hard-fail path (§3.5).
export function providerFromCliName(name: string): Provider {
  const key = name.trim().toLowerCase();
  const match = (Object.entries(PROVIDER_REGISTRY) as [Provider, ProviderInfo][])
    .find(([, info]) => info.cliName === key);
  if (!match) {
    throw new Error(
      `Invalid provider "${name}". Valid providers: ${PROVIDER_CLI_NAMES.join(', ')}.`,
    );
  }
  return match[0];
}

function providerInfo(provider: Provider): ProviderInfo {
  const info = PROVIDER_REGISTRY[provider];
  if (!info) {
    throw new Error(
      `Unknown agent provider: ${provider}. Expected one of: ${Object.keys(PROVIDER_REGISTRY).join(', ')}`,
    );
  }
  return info;
}

// The instruction file the provider's CLI loads natively (§3.2 write side).
export function providerInstructionFile(provider: Provider): string {
  return providerInfo(provider).instructionFile;
}

// The default model for a provider, or null when none can be baked in (OQ1).
// A null return means the caller MUST supply agents.model explicitly.
export function providerDefaultModel(provider: Provider): string | null {
  return providerInfo(provider).defaultModel;
}

// True when the provider has no bakeable default model, so init must prompt for
// (or require) agents.model rather than fall back (OQ1).
export function providerRequiresExplicitModel(provider: Provider): boolean {
  return providerInfo(provider).defaultModel === null;
}

// Resolve the CLI binary for a provider, honouring its SHRENI_*_BIN override.
// Shares resolveBin with the adapters so overrides behave identically.
export function providerBin(provider: Provider): string {
  const info = providerInfo(provider);
  return resolveBin(info.binEnvVar, info.defaultBin);
}