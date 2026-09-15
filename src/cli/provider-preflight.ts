import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { createInterface } from 'readline';
import type { Provider } from '../agents/providers/types.js';
import { PROVIDER_REGISTRY, providerBin } from '../agents/providers/registry.js';
import { AGENT_ROLES, resolveAgentModel, type AgentRole, type KshetraConfig } from '../kshetra/config.js';

// The default provider when init is run without --provider and the operator just
// hits Enter at the prompt (§3.5).
export const DEFAULT_PROVIDER_CLI_NAME = PROVIDER_REGISTRY.anthropic.cliName;

// Interactively ask which provider to use. Returns the CLI-facing name (empty
// input => the Claude default). Kept separate from the resolver so it runs only
// when init has a real TTY — non-interactive callers pass --provider instead.
export async function promptProvider(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Flag experimental providers with a trailing * so the operator sees the
    // caveat before choosing (they still type the plain name).
    const infos = Object.values(PROVIDER_REGISTRY);
    const names = infos.map(i => (i.experimental ? `${i.cliName}*` : i.cliName));
    const legend = infos.some(i => i.experimental) ? '; * = experimental' : '';
    const answer = await new Promise<string>(res =>
      rl.question(
        `Agent provider [${names.join('/')}] (default ${DEFAULT_PROVIDER_CLI_NAME}${legend}): `,
        res,
      ),
    );
    const trimmed = answer.trim();
    return trimmed || DEFAULT_PROVIDER_CLI_NAME;
  } finally {
    rl.close();
  }
}

// Install preflight for the chosen agent provider (the project-init design §3.5). init
// must confirm the provider's CLI is actually on PATH (or pointed at by its
// SHRENI_*_BIN override) BEFORE writing anything — a missing CLI is a hard gate:
// we print how to install it and exit non-zero, leaving the repo untouched.

// True when `bin` is runnable: an absolute/relative path is checked directly,
// a bare command name is looked up across PATH (honouring the platform's
// delimiter). Kept side-effect-free (no spawning) so it stays deterministic and
// testable — resolveBin already normalised the SHRENI_*_BIN override into `bin`.
export function commandExists(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAbsolute(bin) || bin.includes('/')) return existsSync(bin);
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some(dir => existsSync(join(dir, bin)));
}

export interface PreflightResult {
  ok: boolean;
  // The resolved bin that was probed (default or SHRENI_*_BIN override).
  bin: string;
  // Operator-facing install guidance, present only when ok === false.
  message?: string;
}

// Build the install guidance shown when a provider CLI is missing: the resolved
// bin we looked for, the install command, the docs URL, and the re-run hint.
function installMessage(provider: Provider, bin: string): string {
  const info = PROVIDER_REGISTRY[provider];
  return [
    `The ${info.cliName} CLI is required but was not found (looked for "${bin}").`,
    ``,
    `  Install it:  ${info.installCmd}`,
    `  Docs:        ${info.docsUrl}`,
    `  Override:    set ${info.binEnvVar}=/path/to/${info.defaultBin} if it is installed elsewhere`,
    ``,
    `Then re-run:  shreni init-kshetra --provider ${info.cliName} ...`,
  ].join('\n');
}

// Probe the chosen provider's CLI. Returns ok+bin when present; ok=false with an
// install message when missing. Callers (init) must abort without writing on a
// non-ok result.
export function checkProviderInstalled(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  const bin = providerBin(provider);
  if (commandExists(bin, env)) return { ok: true, bin };
  return { ok: false, bin, message: installMessage(provider, bin) };
}

// ── Credential preflight (b0f.3) ──────────────────────────────────────────────
//
// A per-role provider (b0f) means a worker can drive several providers at once
// (e.g. a Claude Silpi with a Codex Viharapala). If a role's provider has no
// credentials, the failure otherwise only shows when THAT agent first runs —
// mid-run, after other work has started. These functions let the worker check
// every role's provider up-front and abort with a clear message instead.

// True when any of the provider's API-key env vars is set to a non-empty value.
function providerKeyed(provider: Provider, env: NodeJS.ProcessEnv): boolean {
  return PROVIDER_REGISTRY[provider].apiKeyEnvVars.some(v => (env[v] ?? '').trim() !== '');
}

// A provider used by one or more roles that has no usable credentials. Only
// providers that REQUIRE an API key (subscriptionAuth === false) can appear here:
// a subscription provider (Anthropic's `claude`) authenticates via its own login,
// so a missing key is never a hard gap.
export interface CredentialGap {
  provider: Provider;
  roles: AgentRole[];
  message: string;
}

// Find every provider a role resolves to that requires an API key but has none
// set. Grouped by provider (one gap per provider, listing the affected roles) so
// the operator sees each missing credential once. A subscription-auth provider
// with no key is intentionally NOT a gap — it runs on the CLI's login.
export function findRoleCredentialGaps(
  kshetra: KshetraConfig,
  env: NodeJS.ProcessEnv = process.env,
): CredentialGap[] {
  const rolesByProvider = new Map<Provider, AgentRole[]>();
  for (const role of AGENT_ROLES) {
    const { provider } = resolveAgentModel(kshetra, role);
    const list = rolesByProvider.get(provider) ?? [];
    list.push(role);
    rolesByProvider.set(provider, list);
  }

  const gaps: CredentialGap[] = [];
  for (const [provider, roles] of rolesByProvider) {
    const info = PROVIDER_REGISTRY[provider];
    if (info.subscriptionAuth) continue; // login/subscription path — no key required
    if (providerKeyed(provider, env)) continue; // key present
    gaps.push({
      provider,
      roles,
      message:
        `${info.cliName} (${provider}) is used by role(s) ${roles.join(', ')} but no API key is set — ` +
        `set ${info.apiKeyEnvVars.join(' or ')} in the environment Shreni runs under before starting.`,
    });
  }
  return gaps;
}
