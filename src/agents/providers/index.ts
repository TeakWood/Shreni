import type { Provider, ProviderAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { geminiAdapter } from './gemini.js';
import { codexAdapter } from './codex.js';

const ADAPTERS: Record<Provider, ProviderAdapter> = {
  anthropic: claudeAdapter,
  gemini: geminiAdapter,
  openai: codexAdapter,
};

export function getAdapter(provider: Provider): ProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`Unknown agent provider: ${provider}. Expected one of: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return adapter;
}

export type { Provider, ProviderAdapter };
export * from './types.js';
export * from './registry.js';
