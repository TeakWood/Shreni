import { z } from 'zod';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import * as yaml from 'js-yaml';
import { join, resolve } from 'path';
import { StackConfigSchema, type StackConfig } from './config.js';

// Packs are versioned, data-only bundles (pack.yaml + conventions templates +
// reference fixture — no executable code) resolved at `shreni init` time only
// and materialized into the Kshetra's own files. The runtime never reads a
// pack: kshetra.yaml stays the single config source of truth, and
// toolchain.ts is deliberately untouched — packs sit above it.
// Precedence: explicit user stack.* > pack values > language profile defaults.

// Scored detection hints for `shreni init` pack suggestion. Data only —
// scoring lives in detect-toolchain.ts, not here.
const DetectSchema = z.strictObject({
  files: z.array(z.string()).optional(),
  packageJson: z
    .strictObject({
      dependencies: z.array(z.string()).optional(),
      devDependencies: z.array(z.string()).optional(),
    })
    .optional(),
  pyproject: z
    .strictObject({
      dependencies: z.array(z.string()).optional(),
    })
    .optional(),
});

// Derived from StackConfigSchema so a pack can say nothing kshetra.yaml
// couldn't already say by hand (ARD G1) — new stack fields become available
// to packs automatically, and pack-only fields are impossible. Strict: an
// unknown field is a validation error, not a silent no-op.
const PackStackSchema = z.strictObject(StackConfigSchema.shape);

export const PackYamlSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/, 'pack name must be lowercase alphanumeric with hyphens'),
  version: z.number().int().positive(),
  description: z.string().optional(),
  detect: DetectSchema.optional(),
  stack: PackStackSchema,
});

export type PackYaml = z.infer<typeof PackYamlSchema>;

export interface Pack extends PackYaml {
  dir: string;
}

// The three conventions templates every pack must ship; init materializes
// them into the Kshetra's .shreni/ (skip-and-warn, never overwrite).
export const PACK_TEMPLATE_FILES = ['style-guide.md', 'arch.md', 'review-guide.md'] as const;

export class PackError extends Error {
  constructor(
    public readonly packDir: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${packDir}] ${message}`);
    this.name = 'PackError';
  }
}

// v1 packs live in-tree under packs/ and ship with the CLI, so the root
// resolves relative to this module (works from src/ via tsx and from the
// compiled output, both two levels below the repo root).
export function defaultPacksDir(): string {
  return resolve(__dirname, '..', '..', 'packs');
}

export function loadPack(packDir: string): Pack {
  const dir = resolve(packDir);
  const yamlPath = join(dir, 'pack.yaml');

  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch (err) {
    throw new PackError(dir, `Cannot read pack.yaml: ${(err as NodeJS.ErrnoException).message}`, err);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new PackError(dir, `Invalid YAML in pack.yaml: ${(err as Error).message}`, err);
  }

  const result = PackYamlSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new PackError(dir, `pack.yaml validation failed:\n${issues}`);
  }

  const missing = PACK_TEMPLATE_FILES.filter(f => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    throw new PackError(dir, `Missing conventions template(s): ${missing.join(', ')}`);
  }

  return { ...result.data, dir };
}

// Every subdirectory of rootDir containing a pack.yaml, validated. A broken
// pack is a hard error — packs ship with the CLI, so one failing to load is a
// packaging bug, not a condition to paper over.
export function listPacks(rootDir: string = defaultPacksDir()): Pack[] {
  const root = resolve(rootDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(name => join(root, name))
    .filter(p => statSync(p).isDirectory() && existsSync(join(p, 'pack.yaml')))
    .map(p => loadPack(p));
}

// The init-time precedence merge: explicit user stack.* values (including ""
// = deliberate skip) win over pack values; where the user is silent the pack
// fills in. Language profile defaults are NOT applied here — the merged
// result lands in kshetra.yaml and toolchain.ts resolves remaining gaps at
// runtime, exactly as it does for a hand-written config.
export function mergeStack(user: Partial<StackConfig> | undefined, pack: StackConfig): StackConfig {
  const merged: Record<string, unknown> = { ...pack };
  for (const [key, value] of Object.entries(user ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return StackConfigSchema.parse(merged);
}
