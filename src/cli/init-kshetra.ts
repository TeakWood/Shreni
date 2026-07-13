import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  writeFileSync, appendFileSync, symlinkSync,
  existsSync, mkdirSync, readFileSync, readlinkSync,
} from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { homedir } from 'os';
import * as yaml from 'js-yaml';
import { registerKshetra } from '../kshetra/registry';
import { loadPackByName, listPacks, mergeStack, type Pack } from '../kshetra/packs';
import type { StackConfig } from '../kshetra/config';
import { detectToolchain, suggestPack, type DetectedStack } from './detect-toolchain';
import { createInterface } from 'readline';
import type { Provider } from '../agents/providers/types';
import {
  providerFromCliName,
  providerDefaultModel,
  providerIsExperimental,
  PROVIDER_REGISTRY,
} from '../agents/providers/registry';
import { checkProviderInstalled, promptProvider, commandExists } from './provider-preflight';
import { emit as emitTelemetry } from '../telemetry/telemetry';

const execAsync = promisify(execFile);

// Canonical config directory (relative to the repo root). Config, conventions
// stubs, and the RAG index all live under here so a Kshetra carries one
// self-contained Shreni footprint. Mirrors the migrate target (migrate.ts).
export const SHRENI_DIR = '.shreni';
export const STYLE_GUIDE_FILE = join(SHRENI_DIR, 'style-guide.md');
export const ARCH_FILE = join(SHRENI_DIR, 'arch.md');
export const REVIEW_GUIDE_FILE = join(SHRENI_DIR, 'review-guide.md');

export interface InitKshetraOpts {
  slug: string;
  path: string;
  org?: string;
  language?: string;
  beadsPath?: string;
  // CLI-facing provider name (claude|codex|gemini). Defaults to claude. An
  // invalid name fails with the valid set (§3.5).
  provider?: string;
  // Explicit agents.model. Required for providers with no bakeable default
  // (codex/gemini, OQ1); optional for claude (falls back to the registry default).
  model?: string;
  // repo.mergePolicy (3r2): 'push' (default) squash-merges to main on APPROVE;
  // 'pr' opens a PR and defers. Omitted => the schema/runtime default 'push'.
  mergePolicy?: 'push' | 'pr';
  // --dry-run (§3.9/OQ7): run preflight + detection and print the plan, mutating
  // nothing (no GitHub repo, symlink, config, or registration).
  dryRun?: boolean;
  // Stack pack selection (84m.2). --pack <name> materializes the pack's stack
  // values + conventions templates at init; --no-pack forces today's bare
  // language-profile path; --upgrade (requires --pack) re-applies a newer pack
  // version to an existing Kshetra: stack values only, docs stay user-owned.
  pack?: string;
  noPack?: boolean;
  upgrade?: boolean;
}

// Resolve the selected provider + model from init opts (§3.5). Validates the
// provider name (invalid => throws with the valid set), then picks the model:
// an explicit --model wins; otherwise the registry default; a provider with no
// default (codex/gemini, OQ1) and no --model is a hard error. Pure — no writes,
// no preflight — so the orchestrator can resolve before touching the filesystem.
export function resolveAgents(opts: { provider?: string; model?: string }): {
  provider: Provider;
  model: string;
} {
  const provider = providerFromCliName(opts.provider ?? PROVIDER_REGISTRY.anthropic.cliName);
  const fallback = providerDefaultModel(provider);
  const model = opts.model ?? fallback;
  if (!model) {
    const info = PROVIDER_REGISTRY[provider];
    throw new Error(
      `Provider "${info.cliName}" has no default model — pass --model <id> (its model ids change often, so none is baked in).`,
    );
  }
  return { provider, model };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toName(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await execAsync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

// ── Step 0: Ensure the app repo exists with an origin remote (yds.11) ─────────

// The zero-repo on-ramp: `shreni init` in a brand-new directory. If the path
// already has an `origin` remote this is a no-op (the yds.1 wrapper path,
// byte-identical). Otherwise: git-init if needed, create the app GitHub repo
// via gh (mirroring the beads-repo flow), wire `origin`, make an initial
// commit on an unborn HEAD, and push — so the Config phase's origin
// requirement is satisfied instead of enforced-and-failed.
export async function ensureAppRepo(org: string, slug: string, repoPath: string): Promise<void> {
  if (!existsSync(join(repoPath, '.git'))) {
    mkdirSync(repoPath, { recursive: true });
    await exec('git', ['init', '-b', 'main'], { cwd: repoPath });
  }

  try {
    await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    return; // already wired — nothing outward-facing happens
  } catch {
    // no origin remote — scaffold it
  }

  const remote = `git@github.com:${org}/${slug}.git`;
  try {
    await exec('gh', ['repo', 'view', `${org}/${slug}`], {});
  } catch {
    await exec('gh', ['repo', 'create', `${org}/${slug}`, '--private', '--confirm'], {});
  }
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: repoPath });

  // Unborn HEAD (fresh git init): commit whatever is present so there is a
  // branch to push; --allow-empty covers the truly empty directory.
  try {
    await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
  } catch {
    await exec('git', ['add', '-A'], { cwd: repoPath });
    await exec('git', ['commit', '--allow-empty', '-m', 'chore: initial commit (shreni init)'], { cwd: repoPath });
  }
  const branch = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  await exec('git', ['push', '-u', 'origin', branch], { cwd: repoPath });
}

// ── Step 1: Create GitHub beads repo ─────────────────────────────────────────

export async function createGitHubRepo(org: string, slug: string): Promise<string> {
  const repoName = `${slug}-beads`;
  const remote = `git@github.com:${org}/${repoName}.git`;
  try {
    await exec('gh', ['repo', 'view', `${org}/${repoName}`], {});
    return remote; // already exists
  } catch {
    await exec('gh', ['repo', 'create', `${org}/${repoName}`, '--private', '--confirm'], {});
    return remote;
  }
}

// ── Step 2: Clone beads repo ──────────────────────────────────────────────────

export async function cloneBeadsRepo(remoteUrl: string, localPath: string): Promise<void> {
  if (existsSync(localPath)) return;
  await exec('git', ['clone', remoteUrl, localPath]);
}

// ── Step 3: bd init --stealth ─────────────────────────────────────────────────

export async function initBeadsDb(beadsPath: string): Promise<void> {
  if (existsSync(join(beadsPath, '.dolt')) || existsSync(join(beadsPath, 'embeddeddolt'))) return;
  await exec('bd', ['init', '--stealth'], {
    cwd: beadsPath,
    env: { ...process.env, BEADS_DIR: beadsPath },
  });
}

// ── Step 4: Create .beads symlink ─────────────────────────────────────────────

export function createBeadsSymlink(repoPath: string, beadsPath: string): void {
  const symlinkPath = join(repoPath, '.beads');
  const target = resolve(beadsPath);
  try {
    const current = readlinkSync(symlinkPath);
    if (resolve(current) === target) return;
    throw new Error(`.beads symlink exists but points to "${current}" instead of "${target}"`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EINVAL') {
      throw new Error(
        `.beads already exists as a directory at "${symlinkPath}". ` +
        `Remove it first: rm -rf "${symlinkPath}"`
      );
    }
    if (code !== 'ENOENT') throw err;
    symlinkSync(target, symlinkPath);
  }
}

// ── Step 5: Update .gitignore ─────────────────────────────────────────────────

// Entries init keeps out of the repo. `.beads` is a machine-local symlink;
// `.shreni/kshetra.yaml` holds ABSOLUTE machine-specific repo/beads paths so it
// must not be committed — but it is ignored by exact path, NOT as `.shreni/`, so
// the tracked conventions docs (.shreni/style-guide.md, .shreni/arch.md) stay
// committable.
const GITIGNORE_MARKERS = ['.beads', `${SHRENI_DIR}/kshetra.yaml`];

export function addToGitignore(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(existing.split('\n').map(l => l.trim()));
  const missing = GITIGNORE_MARKERS.filter(m => !present.has(m));
  if (missing.length === 0) return;

  const block = missing.join('\n');
  if (existing) {
    const sep = existing.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${sep}${block}\n`, 'utf8');
  } else {
    writeFileSync(gitignorePath, `${block}\n`, 'utf8');
  }
}

// ── Step 6: bd setup claude ───────────────────────────────────────────────────

export async function setupClaudeHooks(repoPath: string, beadsPath: string): Promise<void> {
  await exec('bd', ['setup', 'claude'], {
    cwd: repoPath,
    env: { ...process.env, BEADS_DIR: beadsPath },
  });
}

// ── Step 7: Generate kshetra.yaml ─────────────────────────────────────────────

// Build the stack YAML block from a detected profile: always the language, plus
// any populated toolchain fields (packageManager + the build/test/lint commands
// detection resolved). Undefined fields are omitted so non-node configs stay
// minimal; empty-string commands (explicit skips) are kept.
function stackBlock(stack: DetectedStack): Record<string, unknown> {
  const block: Record<string, unknown> = { language: stack.language };
  if (stack.packageManager) block['packageManager'] = stack.packageManager;
  if (stack.buildCommand !== undefined) block['buildCommand'] = stack.buildCommand;
  if (stack.testRunner !== undefined) block['testRunner'] = stack.testRunner;
  if (stack.lintCommand !== undefined) block['lintCommand'] = stack.lintCommand;
  return block;
}

// Smoke-check that the tools behind the resolved build/test gates are actually
// on PATH (§3.6.5). WARN-ONLY (OQ5) — unlike the provider preflight (a hard
// gate), a missing build/test tool is surfaced as a non-fatal warning so init
// still completes; the operator fixes stack.* or installs the tool later. Only
// the leading binary of each command is probed; an empty command ('' = an
// explicitly skipped gate) or an undefined one is left alone.
export function smokeCheckToolchain(stack: DetectedStack): string[] {
  const warnings: string[] = [];
  const gates: [string, string | undefined][] = [
    ['buildCommand', stack.buildCommand],
    ['testRunner', stack.testRunner],
  ];
  for (const [field, cmd] of gates) {
    const bin = cmd?.trim().split(/\s+/)[0];
    if (!bin) continue;
    if (!commandExists(bin)) {
      warnings.push(
        `stack.${field} runs "${bin}", which was not found on PATH — install it or ` +
          `fix the command in ${SHRENI_DIR}/kshetra.yaml (this is a warning, not a failure).`,
      );
    }
  }
  return warnings;
}

// Emit every populated field of a pack-merged stack (framework, coverage,
// globs, …) — unlike stackBlock(), which only carries what detection resolves.
function stackBlockFromConfig(stack: StackConfig): Record<string, unknown> {
  const block: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stack)) {
    if (value !== undefined) block[key] = value;
  }
  return block;
}

// Pack template → repo-relative .shreni/ target (materialization + --upgrade
// diffs both walk this).
const PACK_TEMPLATE_TARGETS: [string, string][] = [
  ['style-guide.md', STYLE_GUIDE_FILE],
  ['arch.md', ARCH_FILE],
  ['review-guide.md', REVIEW_GUIDE_FILE],
];

// Copy the pack's conventions templates into .shreni/ — never overwriting:
// after materialization the docs are user-owned (ARD OQ1), so an existing
// file is skipped with a warning, not merged. Returns the conventions
// pointers for kshetra.yaml (review-guide.md rides the Viharapala-only
// injection channel, Agent-Execution §3.3).
export function materializePackTemplates(pack: Pack, repoPath: string): {
  styleGuide: string;
  architecture: string;
  reviewGuide: string;
} {
  mkdirSync(join(repoPath, SHRENI_DIR), { recursive: true });
  for (const [src, rel] of PACK_TEMPLATE_TARGETS) {
    const dest = join(repoPath, rel);
    if (existsSync(dest)) {
      console.warn(`  ⚠ ${rel} already exists — left untouched (pack template not applied).`);
      continue;
    }
    writeFileSync(dest, readFileSync(join(pack.dir, src), 'utf8'), 'utf8');
  }
  return { styleGuide: STYLE_GUIDE_FILE, architecture: ARCH_FILE, reviewGuide: REVIEW_GUIDE_FILE };
}

// --upgrade never touches the materialized docs; it prints a diff of each one
// against the pristine template for the human to apply (ARD OQ1).
export async function printPackTemplateDiffs(pack: Pack, repoPath: string): Promise<void> {
  for (const [src, rel] of PACK_TEMPLATE_TARGETS) {
    const dest = join(repoPath, rel);
    if (!existsSync(dest)) continue;
    try {
      await exec('diff', ['-u', dest, join(pack.dir, src)]);
    } catch (err) {
      // diff exits 1 when the files differ — its output is the payload.
      const out = (err as { stdout?: string }).stdout;
      console.log(
        `\n  ${rel} differs from the pristine ${pack.name}@${pack.version} template ` +
          `(docs are user-owned — apply manually if wanted):`,
      );
      if (out) console.log(out);
    }
  }
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>(res => rl.question(question, res));
  } finally {
    rl.close();
  }
}

// Suggest-and-confirm (84m.3). A single top scorer asks Y/n; a tie asks which
// of the tied packs to use (blank = none). Declining always falls back to the
// bare language-profile path.
export async function confirmSuggestedPack(repoPath: string): Promise<Pack | undefined> {
  const suggestion = suggestPack(repoPath, listPacks());
  if (suggestion.ambiguous) {
    const top = suggestion.candidates
      .filter(c => c.score === suggestion.candidates[0].score)
      .map(c => c.pack.name);
    const answer = (
      await promptLine(`Multiple packs match this repo (${top.join(', ')}). Type a pack name to use it, or press enter for none: `)
    ).trim();
    if (!answer) return undefined;
    const chosen = suggestion.candidates.find(c => c.pack.name === answer)?.pack;
    if (!chosen) console.warn(`  ⚠ "${answer}" is not one of the matching packs — continuing without a pack.`);
    return chosen;
  }
  if (!suggestion.best) return undefined;
  for (const w of suggestion.warnings) console.warn(`  ⚠ ${w}`);
  const answer = (
    await promptLine(`Detected pack "${suggestion.best.name}@${suggestion.best.version}" for this repo — use it? [Y/n]: `)
  ).trim();
  return answer === '' || /^y(es)?$/i.test(answer) ? suggestion.best : undefined;
}

// --upgrade: update ONLY stack values + provenance in the existing config;
// every other block (gates, agents, watchdog, …) is preserved verbatim.
export function upgradeKshetraStack(configPath: string, stack: StackConfig, provenance: string): void {
  const existing = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  existing['stack'] = stackBlockFromConfig(stack);
  existing['pack'] = provenance;
  writeFileSync(configPath, yaml.dump(existing, { lineWidth: -1 }), 'utf8');
}

export function generateKshetraYaml(opts: {
  slug: string;
  repoPath: string;
  repoRemote: string;
  beadsPath: string;
  beadsRemote: string;
  // Either a detected toolchain profile (preferred) or a bare language string
  // (back-compat) — the language is normalised into a minimal DetectedStack.
  stack?: DetectedStack;
  language?: string;
  // Pack-merged stack values (84m.2): when set, written verbatim as the stack
  // block (all populated fields) instead of the detection-derived stackBlock.
  packStack?: StackConfig;
  // Pack provenance ("<name>@<version>") recorded alongside the stack block.
  pack?: string;
  // Conventions doc pointers (relative to repo root, like conventions.reviewGuide
  // in dispatch.ts). Omitted when init did not scaffold the stubs.
  conventions?: { styleGuide?: string; architecture?: string; reviewGuide?: string };
  // The selected provider + model (§3.5). Defaults to the Claude profile for
  // back-compat when init did not resolve a provider.
  agents?: { provider: Provider; model: string };
  // repo.mergePolicy (3r2). Only written when 'pr' is chosen — 'push' is the
  // schema/runtime default, so omitting it keeps the generated config minimal.
  mergePolicy?: 'push' | 'pr';
}): string {
  const stack: DetectedStack = opts.stack ?? { language: opts.language ?? 'typescript', unknown: false };
  const conventions: Record<string, string> = {};
  if (opts.conventions?.styleGuide) conventions['styleGuide'] = opts.conventions.styleGuide;
  if (opts.conventions?.architecture) conventions['architecture'] = opts.conventions.architecture;
  if (opts.conventions?.reviewGuide) conventions['reviewGuide'] = opts.conventions.reviewGuide;
  const config: Record<string, unknown> = {
    id: opts.slug,
    name: toName(opts.slug),
    repo: {
      path: opts.repoPath,
      remote: opts.repoRemote,
      mainBranch: 'main',
      branchPattern: 'bead-{id}/{slug}',
      // Only emit mergePolicy when 'pr' — 'push' is the default, so a plain
      // config stays clean and back-compatible.
      ...(opts.mergePolicy === 'pr' ? { mergePolicy: 'pr' } : {}),
    },
    beads: {
      path: opts.beadsPath,
      remote: opts.beadsRemote,
      mode: 'embedded',
    },
    stack: opts.packStack ? stackBlockFromConfig(opts.packStack) : stackBlock(stack),
    ...(opts.pack ? { pack: opts.pack } : {}),
    ...(Object.keys(conventions).length ? { conventions } : {}),
    agents: {
      provider: opts.agents?.provider ?? 'anthropic',
      model: opts.agents?.model ?? 'claude-sonnet-4-6',
      maxRoundsPerBead: 3,
    },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  };
  let out = yaml.dump(config, { lineWidth: -1 });
  // Unknown ecosystem: flag the empty commands inline so the operator knows to
  // fill them in (they were written as '' = explicitly-skipped gates).
  if (stack.unknown) {
    out = out.replace(
      /^(\s*language: unknown)$/m,
      '$1  # TODO: unknown ecosystem — set buildCommand/testRunner/lintCommand for your stack',
    );
  }
  return out;
}

// Write the config to the canonical <repo>/.shreni/kshetra.yaml (not the repo
// root — migrate.ts moves any legacy root file here). The loader uses
// repo.path/beads.path verbatim, so the caller must pass a YAML with absolute
// paths already baked in (the orchestrator resolves them before generating).
export function writeKshetraConfig(repoPath: string, content: string): string {
  const shreniDir = join(repoPath, SHRENI_DIR);
  mkdirSync(shreniDir, { recursive: true });
  const configPath = join(shreniDir, 'kshetra.yaml');
  writeFileSync(configPath, content, 'utf8');
  return configPath;
}

// Scaffold the conventions docs Silpi/Viharapala consult, under .shreni/. Both
// are idempotent — an existing file is left untouched so a re-init never clobbers
// operator edits. Returns the repo-relative pointers to wire into conventions.*.
const STYLE_GUIDE_STUB = `# Style Guide

Coding conventions for this project. Shreni's agents read this file when
implementing and reviewing beads. Replace this stub with your real conventions
— naming, formatting, error handling, testing expectations, anything a
contributor should follow.
`;

const ARCH_STUB = `# Architecture

High-level architecture notes for this project. Shreni's agents read this file
for orientation before touching unfamiliar areas. Replace this stub with your
real notes — module boundaries, data flow, key invariants, where things live.
`;

export function scaffoldConventions(repoPath: string): { styleGuide: string; architecture: string } {
  mkdirSync(join(repoPath, SHRENI_DIR), { recursive: true });
  const styleGuidePath = join(repoPath, STYLE_GUIDE_FILE);
  if (!existsSync(styleGuidePath)) writeFileSync(styleGuidePath, STYLE_GUIDE_STUB, 'utf8');
  const archPath = join(repoPath, ARCH_FILE);
  if (!existsSync(archPath)) writeFileSync(archPath, ARCH_STUB, 'utf8');
  return { styleGuide: STYLE_GUIDE_FILE, architecture: ARCH_FILE };
}

// ── Step 8: Append SHRENI INTEGRATION to CLAUDE.md ───────────────────────────

export const SHRENI_SECTION = `
## SHRENI INTEGRATION

This project is managed by Shreni. The Sthapathi daemon picks up beads issues and
implements them via autonomous agents (Silpi, Viharapala, Parikshaka).

**If your system prompt assigns you a Silpi/Viharapala/Parikshaka role for a
specific bead, this section does NOT apply to you** — do your assigned job
(implement / review / analyze) with your tools. The rules below govern
interactive human sessions only.

**Interactive sessions: task producer only.**
Create beads issues for the daemon to implement — do NOT implement tasks yourself.

Prohibited in interactive sessions:
  bd update --claim            Sthapathi claims tasks, not interactive agents
  bd close                     Sthapathi closes tasks on completion
  git checkout -b / git branch Sthapathi owns all bead-* branches

Useful commands:
  shreni status --all          Show all kshetra states
  shreni agents                Show live agent activity
  shreni logs --kshetra <id>   Round-by-round agent logs
  shreni pause --kshetra <id>  Pause task pickup
  shreni resume --kshetra <id> Resume task pickup

### Toolchain config sync

Shreni runs build/test/lint from the pointers in \`.shreni/kshetra.yaml\` (stack.*),
not by re-discovering your toolchain. Whenever you add or change a toolchain
config file — a new test runner (vitest/jest/pytest), linter (eslint), tsconfig,
a new package.json/Makefile script, or you switch package managers — update the
matching pointer in \`.shreni/kshetra.yaml\` in the same change:

  stack.buildCommand   the build/compile gate (e.g. \`pnpm build\`)
  stack.testRunner     the test command (e.g. \`pnpm test\`)
  stack.lintCommand    the lint gate (e.g. \`pnpm lint\`); omit to skip lint

Prefer pointing at a project script (\`pnpm test\`) over duplicating globs. The
escape hatches stack.testFileGlobs / stack.failCountPattern are for non-standard
setups only — set them only when the harness must find tests WITHOUT running the
runner. A stale pointer means Shreni runs the wrong gate.
`;

export function appendShreniIntegration(repoPath: string): void {
  const claudePath = join(repoPath, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const content = readFileSync(claudePath, 'utf8');
    if (content.includes('SHRENI INTEGRATION')) return;
  }
  appendFileSync(claudePath, SHRENI_SECTION, 'utf8');
}

// ── Step 9: RAG index stub ────────────────────────────────────────────────────

export function createRagIndexStub(slug: string): void {
  const ragDir = resolve(homedir(), '.shreni', 'rag', slug);
  mkdirSync(ragDir, { recursive: true });
  const indexPath = join(ragDir, 'index.json');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, JSON.stringify({ chunks: [], version: 1 }, null, 2), 'utf8');
  }
}

// ── Step 10: Register ─────────────────────────────────────────────────────────

export function registerWithSthapathi(slug: string, configPath: string): void {
  registerKshetra(slug, configPath);
}

// ── Orchestrator (§3.9: gated, idempotent, resumable phases) ──────────────────

// One init phase. `run` is idempotent — its actions detect their own output and
// no-op — so a re-run after a fixed failure resumes without duplicating the
// GitHub repo / symlink / config. `recovery` is the WHAT-to-fix guidance printed
// when the phase throws, alongside the exact re-run command.
interface InitPhase {
  name: string;
  run(): Promise<void>;
  recovery: string;
}

// Reconstruct the exact command to re-run init, so a failure message can tell the
// operator precisely how to resume (completed phases will no-op).
function buildReRunCommand(opts: InitKshetraOpts): string {
  const parts = ['shreni init-kshetra', `--slug ${opts.slug}`, `--path ${opts.path}`];
  if (opts.org) parts.push(`--org ${opts.org}`);
  if (opts.provider) parts.push(`--provider ${opts.provider}`);
  if (opts.model) parts.push(`--model ${opts.model}`);
  if (opts.language) parts.push(`--language ${opts.language}`);
  if (opts.beadsPath) parts.push(`--beads-path ${opts.beadsPath}`);
  if (opts.mergePolicy) parts.push(`--merge-policy ${opts.mergePolicy}`);
  if (opts.pack) parts.push(`--pack ${opts.pack}`);
  if (opts.noPack) parts.push('--no-pack');
  if (opts.upgrade) parts.push('--upgrade');
  return parts.join(' ');
}

// Run the mutating phases in order, printing a running/done/failed line each. On
// the first failure, print WHAT failed + HOW to recover + the exact re-run
// command, then re-throw so the CLI exits non-zero. Later phases do not run.
async function runInitPhases(phases: InitPhase[], reRunCmd: string): Promise<void> {
  for (const phase of phases) {
    console.log(`▶ ${phase.name} …`);
    try {
      await phase.run();
      console.log(`  ✓ ${phase.name}`);
    } catch (err) {
      const e = err as Error;
      console.error(`  ✗ ${phase.name} failed: ${e.message}`);
      console.error(`\n  To recover: ${phase.recovery}`);
      console.error(`  Then re-run (completed phases are skipped):\n    ${reRunCmd}`);
      throw err;
    }
  }
}

export async function initKshetra(opts: InitKshetraOpts): Promise<void> {
  const org = opts.org ?? 'TeakWood';
  const repoPath = resolve(opts.path);

  // ── Pack selection (84m.2) ───────────────────────────────────────────────────
  if (opts.pack && opts.noPack) {
    throw new Error('--pack and --no-pack are mutually exclusive.');
  }
  if (opts.upgrade && !opts.pack) {
    throw new Error('--upgrade requires --pack <name>.');
  }
  // Load + validate the pack before anything mutates (a bad pack aborts clean).
  let pack: Pack | undefined = opts.pack ? loadPackByName(opts.pack) : undefined;

  // No explicit --pack: score installed packs' detect blocks and SUGGEST the
  // best match with interactive confirm (84m.3). Never silently applied: a
  // non-TTY run and --no-pack keep today's bare-profile path byte-identically.
  if (!pack && !opts.noPack && process.stdin.isTTY) {
    pack = await confirmSuggestedPack(repoPath);
  }

  // Precedence (ARD G4): explicit user stack.* (--language) > pack values;
  // language-profile defaults still fill remaining gaps at runtime.
  const packStack: StackConfig | undefined = pack
    ? mergeStack(opts.language ? { language: opts.language } : undefined, pack.stack)
    : undefined;

  // --upgrade is a narrow re-application, not a re-init: update stack values +
  // provenance in the existing config, print template diffs (docs stay
  // user-owned, ARD OQ1), and stop — no repo/beads/register phases.
  if (opts.upgrade && pack && packStack) {
    const configPath = join(repoPath, SHRENI_DIR, 'kshetra.yaml');
    if (!existsSync(configPath)) {
      throw new Error(`Nothing to upgrade: no config at ${configPath}. Run \`shreni init --pack ${pack.name}\` first.`);
    }
    upgradeKshetraStack(configPath, packStack, `${pack.name}@${pack.version}`);
    console.log(`✓ stack values updated to ${pack.name}@${pack.version} in ${configPath} (other config blocks untouched).`);
    await printPackTemplateDiffs(pack, repoPath);
    return;
  }
  const beadsPath = opts.beadsPath
    ? resolve(opts.beadsPath)
    : resolve(join(dirname(repoPath), `${basename(repoPath)}-beads`));
  const reRunCmd = buildReRunCommand(opts);

  // ── Preflight (§3.5) — provider selection + install hard gate + detection ────
  // This runs BEFORE any network call or filesystem write and is the whole of
  // --dry-run. When --provider is omitted and init has a real TTY, ask
  // interactively (default Claude); otherwise take the flag (or fall through to
  // the Claude default). An invalid provider throws with the valid set; a missing
  // provider CLI is a hard gate that leaves the repo untouched.
  const providerName =
    opts.provider ?? (process.stdin.isTTY ? await promptProvider() : undefined);
  const agents = resolveAgents({ provider: providerName, model: opts.model });
  const preflight = checkProviderInstalled(agents.provider);
  if (!preflight.ok) {
    throw new Error(preflight.message);
  }
  const providerLabel = `${PROVIDER_REGISTRY[agents.provider].cliName} (${agents.model})`;
  console.log(`Provider: ${providerLabel} — CLI found at "${preflight.bin}".`);
  if (providerIsExperimental(agents.provider)) {
    console.warn(
      `  ⚠ ${PROVIDER_REGISTRY[agents.provider].cliName} is EXPERIMENTAL — its adapter is draft and ` +
        `not verified end-to-end. Claude is the supported provider; expect rough edges on this one.`,
    );
  }

  // Detect the ecosystem from marker files (pure read); an explicit --language
  // overrides the detected language but keeps any detected packageManager/commands.
  // A selected pack replaces detection: its merged stack is authoritative.
  const stack: DetectedStack = packStack
    ? {
        language: packStack.language,
        packageManager: packStack.packageManager,
        buildCommand: packStack.buildCommand,
        testRunner: packStack.testRunner,
        lintCommand: packStack.lintCommand,
        unknown: false,
      }
    : opts.language
      ? { ...detectToolchain(repoPath), language: opts.language }
      : detectToolchain(repoPath);
  if (pack) {
    console.log(`  Using pack ${pack.name}@${pack.version} (${stack.language}).`);
  } else if (stack.unknown) {
    console.warn(
      `  ⚠ Could not detect the ecosystem in ${repoPath}. Will write a config with empty ` +
        `build/test/lint commands — edit stack.* in the config to point at your build/test/lint.`,
    );
  } else {
    console.log(`  Detected ${stack.language}${stack.packageManager ? ` (${stack.packageManager})` : ''}.`);
  }
  // Warn-only smoke-check (§3.6.5): surface a missing build/test tool now instead
  // of letting it fail silently on the first bead. Never aborts init.
  for (const warning of smokeCheckToolchain(stack)) {
    console.warn(`  ⚠ ${warning}`);
  }

  const configTarget = join(repoPath, SHRENI_DIR, 'kshetra.yaml');
  if (opts.dryRun) {
    console.log('\n--dry-run — plan only, nothing written:');
    console.log(`  provider:    ${providerLabel}`);
    console.log(`  repo:        ${repoPath}`);
    console.log(`  beads repo:  ${beadsPath}`);
    console.log(`  config:      ${configTarget}`);
    if (pack) console.log(`  pack:        ${pack.name}@${pack.version}`);
    console.log(`  conventions: ${join(repoPath, STYLE_GUIDE_FILE)}, ${join(repoPath, ARCH_FILE)}${pack ? `, ${join(repoPath, REVIEW_GUIDE_FILE)}` : ''}`);
    console.log('\nRe-run without --dry-run to apply.');
    return;
  }

  // ── Mutating phases ──────────────────────────────────────────────────────────
  // Shared state threaded between phases via closures.
  let beadsRemote = '';
  let configPath = configTarget;

  const phases: InitPhase[] = [
    {
      name: 'App repo',
      recovery:
        `ensure \`gh\` is authenticated (gh auth status) and you can push to GitHub; ` +
        `or create the repo at ${repoPath} yourself with an 'origin' remote and re-run.`,
      run: async () => {
        await ensureAppRepo(org, opts.slug, repoPath);
      },
    },
    {
      name: 'Beads repo',
      recovery:
        `ensure \`gh\` is authenticated (gh auth status) and you can reach GitHub, ` +
        `or pass --beads-path to point at an existing beads repo.`,
      run: async () => {
        if (opts.beadsPath && existsSync(beadsPath)) {
          console.log(`  using existing beads repo at ${beadsPath} — skipping create/clone`);
          try {
            beadsRemote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: beadsPath });
          } catch {
            beadsRemote = '';
          }
        } else {
          beadsRemote = await createGitHubRepo(org, opts.slug);
          await cloneBeadsRepo(beadsRemote, beadsPath);
        }
        await initBeadsDb(beadsPath);
      },
    },
    {
      name: 'Repo wiring',
      recovery:
        `if .beads exists as a real directory, remove it (rm -rf .beads); ` +
        `ensure \`bd\` is installed for the Claude Code hooks.`,
      run: async () => {
        createBeadsSymlink(repoPath, beadsPath);
        addToGitignore(repoPath);
        await setupClaudeHooks(repoPath, beadsPath);
      },
    },
    {
      name: 'Config',
      recovery:
        `ensure the repo at ${repoPath} has an 'origin' remote ` +
        `(git -C ${repoPath} remote get-url origin).`,
      run: async () => {
        const repoRemote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
        // repoPath/beadsPath are already absolute; the loader does NOT expand ~ or
        // resolve relatives, so init bakes absolute paths in.
        // A pack materializes its own conventions templates (skip-and-warn);
        // otherwise the generic stubs are scaffolded as before.
        const conventions = pack
          ? materializePackTemplates(pack, repoPath)
          : scaffoldConventions(repoPath);
        const yamlContent = generateKshetraYaml({
          slug: opts.slug,
          repoPath,
          repoRemote,
          beadsPath,
          beadsRemote,
          stack,
          packStack,
          pack: pack ? `${pack.name}@${pack.version}` : undefined,
          conventions,
          agents,
          mergePolicy: opts.mergePolicy,
        });
        configPath = writeKshetraConfig(repoPath, yamlContent);
        appendShreniIntegration(repoPath);
        createRagIndexStub(opts.slug);
      },
    },
    {
      name: 'Register',
      recovery: `check that ~/.shreni/registry.json is writable.`,
      run: async () => {
        registerWithSthapathi(opts.slug, configPath);
      },
    },
  ];

  await runInitPhases(phases, reRunCmd);

  // Activation-funnel signal (yds.5) — opt-in + anonymous, a no-op unless
  // enabled. Only the provider name (not the slug/paths/remote) is sent.
  emitTelemetry('kshetra_init', { provider: agents.provider });

  console.log(`\n✓ Kshetra "${opts.slug}" initialised.`);
  console.log(`  provider:   ${providerLabel}`);
  console.log(`  config:     ${configPath}`);
  console.log(`  beads repo: ${beadsPath}`);
  console.log(`\nRun \`shreni start\` to begin.`);
}