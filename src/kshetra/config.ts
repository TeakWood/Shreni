import { z } from 'zod';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { resolve } from 'path';

const RepoConfigSchema = z.object({
  path: z.string(),
  remote: z.string(),
  mainBranch: z.string().default('main'),
  branchPattern: z.string().default('bead-{id}/{slug}'),
});

const BeadsConfigSchema = z.object({
  path: z.string(),
  remote: z.string(),
  mode: z.literal('embedded').default('embedded'),
});

const StackConfigSchema = z.object({
  language: z.string(),
  framework: z.string().optional(),
  testRunner: z.string().optional(),
  linter: z.string().optional(),
});

const ConventionsConfigSchema = z.object({
  styleGuide: z.string().optional(),
  architecture: z.string().optional(),
});

const AgentsConfigSchema = z.object({
  provider: z.enum(['anthropic', 'gemini', 'openai']).default('anthropic'),
  model: z.string().default('claude-sonnet-4'),
  maxRoundsPerBead: z.number().int().min(1).default(3),
});

const PriorityConfigSchema = z.object({
  p0AutoAssign: z.boolean().default(true),
  maxConcurrentBeads: z.number().int().min(1).default(1),
});

export const KshetraConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  name: z.string(),
  description: z.string().optional(),
  repo: RepoConfigSchema,
  beads: BeadsConfigSchema,
  stack: StackConfigSchema,
  conventions: ConventionsConfigSchema.default({ styleGuide: undefined, architecture: undefined }),
  agents: AgentsConfigSchema.default({ provider: 'anthropic', model: 'claude-sonnet-4', maxRoundsPerBead: 3 }),
  priority: PriorityConfigSchema.default({ p0AutoAssign: true, maxConcurrentBeads: 1 }),
});

export type KshetraConfig = z.infer<typeof KshetraConfigSchema>;

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
