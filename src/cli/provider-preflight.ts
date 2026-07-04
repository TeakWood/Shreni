import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { createInterface } from 'readline';
import type { Provider } from '../agents/providers/types.js';
import { PROVIDER_REGISTRY, PROVIDER_CLI_NAMES, providerBin } from '../agents/providers/registry.js';

// The default provider when init is run without --provider and the operator just
// hits Enter at the prompt (§3.5).
export const DEFAULT_PROVIDER_CLI_NAME = PROVIDER_REGISTRY.anthropic.cliName;

// Interactively ask which provider to use. Returns the CLI-facing name (empty
// input => the Claude default). Kept separate from the resolver so it runs only
// when init has a real TTY — non-interactive callers pass --provider instead.
export async function promptProvider(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(res =>
      rl.question(
        `Agent provider [${PROVIDER_CLI_NAMES.join('/')}] (default ${DEFAULT_PROVIDER_CLI_NAME}): `,
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