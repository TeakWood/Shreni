import { resolve, join } from 'path';
import { loadKshetraConfig, KshetraConfigError } from '../kshetra/config.js';
import { registerKshetra } from '../kshetra/registry.js';

export interface RegisterResult {
  status: 'registered' | 're_registered';
  id: string;
  configPath: string;
}

export function runRegister(kshetraPath: string): RegisterResult {
  const resolvedPath = resolve(kshetraPath);
  const configPath = join(resolvedPath, 'kshetra.yaml');

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