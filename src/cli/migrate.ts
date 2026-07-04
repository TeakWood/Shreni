import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import * as yaml from 'js-yaml';
import { loadKshetraConfig, KshetraConfigError } from '../kshetra/config.js';
import { registerKshetra } from '../kshetra/registry.js';

export type MigrateStatus = 'migrated' | 'already_canonical' | 'nothing_to_migrate';

export interface MigrateResult {
  status: MigrateStatus;
  id?: string;
  configPath: string;
}

// Absolutize a config path field. Expands a leading `~` to the home directory
// and resolves a relative path against the Kshetra directory. The loader uses
// repo.path / beads.path verbatim as the git/exec cwd and does NOT expand `~`
// (config.ts), so migration is where those paths are made absolute.
function absolutizePath(p: string, baseDir: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(baseDir, p);
}

// Move a legacy root `<dir>/kshetra.yaml` to the canonical
// `<dir>/.shreni/kshetra.yaml`, absolutize its repo/beads paths, re-register the
// Kshetra to point at the new location, and delete the root file. Idempotent:
// re-running once the canonical file exists (and the root is gone) is a no-op.
export function runMigrate(kshetraPath: string): MigrateResult {
  const dir = resolve(kshetraPath);
  const rootPath = join(dir, 'kshetra.yaml');
  const canonicalPath = join(dir, '.shreni', 'kshetra.yaml');

  const rootExists = existsSync(rootPath);
  const canonicalExists = existsSync(canonicalPath);

  // Already migrated (or a fresh init wrote canonical directly): nothing to do.
  // If a stale root file lingers next to the canonical one, remove it so there
  // is exactly one source of truth.
  if (canonicalExists) {
    if (rootExists) rmSync(rootPath);
    return { status: rootExists ? 'migrated' : 'already_canonical', configPath: canonicalPath };
  }

  if (!rootExists) {
    return { status: 'nothing_to_migrate', configPath: canonicalPath };
  }

  // Parse the legacy YAML, absolutize the path fields, and write the canonical
  // file. We mutate the parsed object (not the raw text) so the paths are fixed;
  // formatting/comments are not preserved by design (this is a one-time move).
  let raw: string;
  try {
    raw = readFileSync(rootPath, 'utf8');
  } catch (err) {
    throw new KshetraConfigError(rootPath, `Cannot read file: ${(err as Error).message}`, err);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>;
  } catch (err) {
    throw new KshetraConfigError(rootPath, `Invalid YAML: ${(err as Error).message}`, err);
  }

  const repo = parsed['repo'] as { path?: string } | undefined;
  if (repo?.path) repo.path = absolutizePath(repo.path, dir);
  const beads = parsed['beads'] as { path?: string } | undefined;
  if (beads?.path) beads.path = absolutizePath(beads.path, dir);

  mkdirSync(dirname(canonicalPath), { recursive: true });
  writeFileSync(canonicalPath, yaml.dump(parsed), 'utf8');

  // Validate the migrated config and re-register it to the canonical path. If
  // validation fails, remove the partial canonical file (so a retry doesn't see
  // an invalid file as "already migrated") and leave the root untouched.
  let config;
  try {
    config = loadKshetraConfig(canonicalPath);
  } catch (err) {
    rmSync(canonicalPath, { force: true });
    throw err;
  }
  registerKshetra(config.id, canonicalPath);

  // Only remove the legacy file once the canonical one is written and valid.
  rmSync(rootPath);

  return { status: 'migrated', id: config.id, configPath: canonicalPath };
}