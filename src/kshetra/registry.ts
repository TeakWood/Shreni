import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { loadKshetraConfig, KshetraConfigError, type KshetraConfig } from './config.js';

const REGISTRY_PATH = resolve(homedir(), '.shreni', 'registry.json');

interface RegistryEntry {
  id: string;
  configPath: string;
  registeredAt: string;
}

interface Registry {
  kshetras: RegistryEntry[];
}

function readRegistry(): Registry {
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw) as Registry;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { kshetras: [] };
    throw new Error(`Cannot read registry at ${REGISTRY_PATH}: ${e.message}`);
  }
}

function writeRegistry(registry: Registry): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
}

export function loadRegistry(): KshetraConfig[] {
  const registry = readRegistry();
  const configs: KshetraConfig[] = [];

  for (const entry of registry.kshetras) {
    try {
      const config = loadKshetraConfig(entry.configPath);
      configs.push(config);
    } catch (err) {
      if (
        err instanceof KshetraConfigError &&
        (err.cause as NodeJS.ErrnoException)?.code === 'ENOENT'
      ) {
        console.warn(
          `[registry] Skipping kshetra "${entry.id}": config not found at ${entry.configPath}`,
        );
      } else {
        console.warn(
          `[registry] Skipping kshetra "${entry.id}": ${(err as Error).message}`,
        );
      }
    }
  }

  return configs;
}

export function registerKshetra(id: string, configPath: string): void {
  const registry = readRegistry();
  const resolved = resolve(configPath);

  const existing = registry.kshetras.findIndex(k => k.id === id);
  const entry: RegistryEntry = {
    id,
    configPath: resolved,
    registeredAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    registry.kshetras[existing] = entry;
  } else {
    registry.kshetras.push(entry);
  }

  writeRegistry(registry);
}

export function unregisterKshetra(id: string): void {
  const registry = readRegistry();
  registry.kshetras = registry.kshetras.filter(k => k.id !== id);
  writeRegistry(registry);
}
