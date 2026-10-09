import { z } from 'zod';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { resolve } from 'path';

// Project config (policy spec, "Project config"): one config file per kind of
// project, both built on one shared schema. A Kshetra's settings live in
// .shreni/kshetra.yaml (KshetraConfigSchema, config.ts) and a tracker's in
// .shreni/tracker.yaml; anything that serves both kinds reads the base.

/** A validator's severity, or off. */
const Level = z.enum(['error', 'warning', 'off']);
/** `coverage: error`, or the object form with the validator's own options. */
const setting = (options: z.ZodRawShape = {}) =>
  z.preprocess(v => (typeof v === 'string' ? { level: v } : v), z.object({ level: Level, ...options }).strict());
export type ValidatorSetting = { level: z.infer<typeof Level> } & Record<string, unknown>;

/** Shreni's validators (policy spec, "Validators") and their options; a typo fails rather than being ignored. */
const ValidatorSettings = z.object({
  acceptanceChecks: setting(),
  coverage: setting(),
  graphShape: setting({ maxTasks: z.number().int().positive().optional(), maxDepth: z.number().int().positive().optional() }),
  collisions: setting(),
}).partial().strict();

/** Where every project starts (policy spec, "Validators"); either file overrides them per validator. */
export const VALIDATOR_DEFAULTS: Readonly<Record<string, ValidatorSetting>> = {
  acceptanceChecks: { level: 'error' },
  coverage: { level: 'error' },
  graphShape: { level: 'warning' },
  collisions: { level: 'warning' },
};

export const ProjectConfigBase = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** The project's uuid in the database; set when init registers it. */
  project: z.string().uuid().optional(),
  /** The entry in ~/.shreni/config.yaml naming the database this repo uses. */
  database: z.string().min(1).default('local'),
  plan: z.object({
    validators: ValidatorSettings.default({}),
  }).strict().default({ validators: {} }),
});
export type ProjectConfig = z.infer<typeof ProjectConfigBase>;

/** The agent CLIs people use in a tracked repo; they pick its instruction files. */
const Provider = z.enum(['claude', 'codex', 'gemini']);

/** Strict: a key only a Kshetra has (repo, agents…) fails, naming the key. */
export const TrackerConfigSchema = ProjectConfigBase.extend({
  providers: z.array(Provider).min(1).default(['claude']),
}).strict();
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

/** Each validator's effective setting: the defaults, with the project's file over them. */
export function validatorSettings(config: Pick<ProjectConfig, 'plan'>): Record<string, ValidatorSetting> {
  const out: Record<string, ValidatorSetting> = { ...VALIDATOR_DEFAULTS };
  for (const [name, s] of Object.entries(config.plan.validators)) {
    if (s !== undefined) out[name] = s as ValidatorSetting;
  }
  return out;
}

export class TrackerConfigError extends Error {
  constructor(readonly configPath: string, message: string, readonly cause?: unknown) {
    super(`[${configPath}] ${message}`);
    this.name = 'TrackerConfigError';
  }
}

export function loadTrackerConfig(configPath: string): TrackerConfig {
  const resolved = resolve(configPath);
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new TrackerConfigError(resolved, `Cannot read: ${(err as Error).message}`, err);
  }
  const result = TrackerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => {
      const keys = (i as { keys?: string[] }).keys;
      const where = i.path.join('.') || '(root)';
      return keys?.length ? `  ${where}: ${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'} not a tracker setting` : `  ${where}: ${i.message}`;
    }).join('\n');
    throw new TrackerConfigError(resolved, `Schema validation failed:\n${issues}`);
  }
  return result.data;
}
