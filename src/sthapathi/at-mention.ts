import type { KshetraConfig } from '../kshetra/config.js';

export interface AtMentionResult {
  kshetraId: string;
  text: string;
}

// Parses "@kshetra-id rest of message" from a Vichara chat input.
// Returns null when no @mention prefix is found.
export function parseAtMention(input: string): AtMentionResult | null {
  const match = input.match(/^@([a-z0-9-]+)\s+([\s\S]+)$/);
  if (!match) return null;
  return { kshetraId: match[1]!, text: match[2]!.trim() };
}

// Resolves the kshetra config for a parsed @mention id.
// Returns null when no registered kshetra matches.
export function resolveAtMentionKshetra(
  kshetraId: string,
  kshetras: KshetraConfig[],
): KshetraConfig | null {
  return kshetras.find(k => k.id === kshetraId) ?? null;
}