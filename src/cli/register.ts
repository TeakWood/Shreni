import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { loadKshetraConfig, KshetraConfigError } from '../kshetra/config.js';
import { registerKshetra } from '../kshetra/registry.js';

export interface RegisterResult {
  status: 'registered' | 're_registered';
  id: string;
  configPath: string;
}

// Resolve the config for a Kshetra directory. The canonical location is
// `<dir>/.shreni/kshetra.yaml` (one source of truth, the project-init design §3.1); a
// root `<dir>/kshetra.yaml` is the legacy layout we still accept (and that
// `shreni migrate` moves). Prefer the canonical file when it exists.
export function resolveConfigPath(dir: string): string {
  const canonical = join(dir, '.shreni', 'kshetra.yaml');
  if (existsSync(canonical)) return canonical;
  return join(dir, 'kshetra.yaml');
}

export function runRegister(kshetraPath: string): RegisterResult {
  const resolvedPath = resolve(kshetraPath);
  const configPath = resolveConfigPath(resolvedPath);

  let config;
  try {
    config = loadKshetraConfig(configPath);
  } catch (err) {
    if (err instanceof KshetraConfigError) throw err;
    throw new KshetraConfigError(configPath, (err as Error).message, err);
  }

  registerKshetra(config.id, configPath);

  return { status: 'registered', id: config.id, configPath };
}