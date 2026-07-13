import { z } from 'zod';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { resolve } from 'path';
import { providerDefaultModel } from '../agents/providers/registry.js';

// Single source of truth for the default agent model. Codex/Gemini have no
// bakeable default (providerDefaultModel returns null, OQ1), so the schema
// default is the confirmed Claude model; a Codex/Gemini Kshetra sets agents.model
// explicitly at init.
const DEFAULT_AGENT_MODEL = providerDefaultModel('anthropic') as string;

const RepoConfigSchema = z.object({
  path: z.string(),
  remote: z.string(),
  mainBranch: z.string().default('main'),
  branchPattern: z.string().default('bead-{id}/{slug}'),
  // Where approved work lands (3r2). 'push' (default): squash-merge the bead
  // branch straight to main on APPROVE — today's behaviour. 'pr': open a PR
  // (bead branch → main) and DEFER — the bead is kept open (in_progress +
  // `awaiting-merge` label) so bd dependents stay blocked until the code is on
  // main, and is closed only when its PR actually merges (reconcilePullRequests).
  // Optional for back-compat; resolveMergePolicy() treats an absent value as
  // 'push' and lets SHRENI_MERGE_POLICY override at runtime.
  mergePolicy: z.enum(['push', 'pr']).optional(),
});

const BeadsConfigSchema = z.object({
  path: z.string(),
  remote: z.string(),
  mode: z.literal('embedded').default('embedded'),
});

export const StackConfigSchema = z.object({
  language: z.string(),
  framework: z.string().optional(),
  // Selects the default command family for node profiles (pnpm/npm/yarn).
  packageManager: z.string().optional(),
  testRunner: z.string().optional(),
  linter: z.string().optional(),
  // Authoritative build/compile gate Viharapala must pass before approving a
  // task branch. For TS/Next projects `next build` runs tsc, so `pnpm build`
  // (the default) doubles as the type-check gate — there is no separate tsc
  // script. A failing build means type errors reached the branch. Omit to use
  // the language default; set to "" to explicitly skip the build gate.
  buildCommand: z.string().optional(),
  // Enforced lint gate (the toolchain design §3.3). When set, the harness runs it as
  // an independent gate; omit to skip lint (never synthesised for a repo that
  // has none).
  lintCommand: z.string().optional(),
  // Coverage gate/report command. Omit to use the language default (e.g.
  // `<pm> test:coverage` on node); set to "" when the repo has no coverage
  // script so the gate visibly skips.
  coverageCommand: z.string().optional(),
  // Optional escape hatches (§3.4) — usually unnecessary; the runner's own
  // config already declares these. Set testFileGlobs/vendorDirs only when the
  // harness must discover tests WITHOUT invoking the runner (Parikshaka's
  // static walk), and failCountPattern only for a non-standard test summary.
  testFileGlobs: z.array(z.string()).optional(),
  vendorDirs: z.array(z.string()).optional(),
  failCountPattern: z.string().optional(),
});

const ConventionsConfigSchema = z.object({
  styleGuide: z.string().optional(),
  architecture: z.string().optional(),
  // Reviewer-only custom instructions (the agent-execution design §3.3 channel B). A
  // pointer to a file Shreni reads and injects into the Viharapala prompt ONLY —
  // no provider has a reviewer-only native file, so this is the one role-scoped
  // injection that survives the native flip. Adds review criteria/rubric but
  // cannot disable a Shreni hard gate (precedence: gates > reviewGuide > shared
  // native criteria). Shared criteria that should also shape Silpi belong in the
  // native instruction file / @-imported .shreni/review-guide.md instead.
  reviewGuide: z.string().optional(),
});

const AgentsConfigSchema = z.object({
  provider: z.enum(['anthropic', 'gemini', 'openai']).default('anthropic'),
  model: z.string().default(DEFAULT_AGENT_MODEL),
  maxRoundsPerBead: z.number().int().min(1).default(3),
});

// RESERVED — neither field is read at runtime yet. p0AutoAssign (auto-assign P0
// beads) and maxConcurrentBeads (per-Kshetra concurrency) are accepted and
// validated so existing configs keep working and the fields are stable, but they
// currently drive nothing. Concurrency is a Non-Goal in the design-Sthapathi; wire these
// up (or drop them) before relying on either. See the project-init design §3.7 / OQ2.
const PriorityConfigSchema = z.object({
  p0AutoAssign: z.boolean().default(true),
  maxConcurrentBeads: z.number().int().min(1).default(1),
});

// Configurable quality gates (delegate-first): entries carry ONLY an
// enforcement level — the command each gate runs resolves from the toolchain
// single-source (resolveTest/Lint/CoverageCommand), never restated here.
// Gates are additive-stricter: the hard build/test/lint gates sit above this
// layer and cannot be waived (a 'warn' on test/lint is clamped to block by the
// evaluator); a repo opts out of a gate by emptying its toolchain command
// (e.g. lintCommand: ''), which is a visible skip. Coverage defaults to warn
// (advisory, matching Parikshaka today).
const GateEntrySchema = z.object({
  level: z.enum(['block', 'warn']),
});

// The one loop-native guard (no equivalent in the repo's own tooling): caps the
// bead branch's diff against main. Conservative warn-level defaults — a
// runaway-agent tripwire, not a style rule; raise to block for repos where an
// oversized diff must never reach review.
const DiffSizeGateSchema = z.object({
  level: z.enum(['block', 'warn']).default('warn'),
  maxFiles: z.number().int().positive().default(40),
  maxLines: z.number().int().positive().default(1500),
});

const GATES_DEFAULTS = {
  test: { level: 'block' },
  lint: { level: 'block' },
  coverage: { level: 'warn' },
  diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
} as const;

const GatesConfigSchema = z.object({
  test: GateEntrySchema.default(GATES_DEFAULTS.test),
  lint: GateEntrySchema.default(GATES_DEFAULTS.lint),
  coverage: GateEntrySchema.default(GATES_DEFAULTS.coverage),
  diffSize: DiffSizeGateSchema.default(GATES_DEFAULTS.diffSize),
});

// Optional per-Kshetra overrides for the stuck-watchdog and recovery budget.
// Any omitted field falls back to the defaults in watchdog.ts / recover.ts.
const WatchdogConfigSchema = z.object({
  stuckThresholdMs: z.number().int().positive().optional(),
  maxOutcomeRepeat: z.number().int().min(1).optional(),
  maxRecoverAttempts: z.number().int().min(1).optional(),
});

export const KshetraConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  name: z.string(),
  description: z.string().optional(),
  repo: RepoConfigSchema,
  beads: BeadsConfigSchema,
  stack: StackConfigSchema,
  // Provenance only ("<name>@<version>", e.g. nextjs-vitest@1): records which
  // stack pack init materialized this config from. Nothing resolves through it
  // at runtime — the pack's values were written into stack.* at init.
  pack: z.string().regex(/^[a-z0-9-]+@\d+$/, 'pack must be "<name>@<version>"').optional(),
  conventions: ConventionsConfigSchema.default({ styleGuide: undefined, architecture: undefined }),
  agents: AgentsConfigSchema.default({ provider: 'anthropic', model: DEFAULT_AGENT_MODEL, maxRoundsPerBead: 3 }),
  priority: PriorityConfigSchema.default({ p0AutoAssign: true, maxConcurrentBeads: 1 }),
  gates: GatesConfigSchema.default(GATES_DEFAULTS),
  watchdog: WatchdogConfigSchema.optional(),
});

export type KshetraConfig = z.infer<typeof KshetraConfigSchema>;
export type StackConfig = z.infer<typeof StackConfigSchema>;

export class KshetraConfigError extends Error {
  constructor(
    public readonly configPath: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${configPath}] ${message}`);
    this.name = 'KshetraConfigError';
  }
}

export function loadKshetraConfig(configPath: string): KshetraConfig {
  const resolved = resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new KshetraConfigError(resolved, `Cannot read file: ${(err as NodeJS.ErrnoException).message}`, err);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new KshetraConfigError(resolved, `Invalid YAML: ${(err as Error).message}`, err);
  }

  const result = KshetraConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new KshetraConfigError(resolved, `Schema validation failed:\n${issues}`);
  }

  return result.data;
}
