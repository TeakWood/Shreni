import { describe, it, expect } from 'vitest';
import {
  providerInstructionFile,
  providerDefaultModel,
  providerRequiresExplicitModel,
  providerBin,
  providerFromCliName,
  PROVIDER_CLI_NAMES,
  PROVIDER_REGISTRY,
} from './registry.js';
import type { Provider } from './types.js';

const ALL: Provider[] = ['anthropic', 'openai', 'gemini'];

describe('providerInstructionFile', () => {
  it('maps anthropic -> CLAUDE.md', () => {
    expect(providerInstructionFile('anthropic')).toBe('CLAUDE.md');
  });
  it('maps openai -> AGENTS.md', () => {
    expect(providerInstructionFile('openai')).toBe('AGENTS.md');
  });
  it('maps gemini -> GEMINI.md', () => {
    expect(providerInstructionFile('gemini')).toBe('GEMINI.md');
  });
  it('maps all three providers to a file', () => {
    for (const p of ALL) expect(providerInstructionFile(p)).toMatch(/\.md$/);
  });
  it('throws on an unknown provider', () => {
    // @ts-expect-error testing runtime guard with bad input
    expect(() => providerInstructionFile('bogus')).toThrow('Unknown agent provider');
  });
});

describe('providerDefaultModel', () => {
  it('returns the confirmed Claude default (OQ1)', () => {
    expect(providerDefaultModel('anthropic')).toBe('claude-sonnet-4-6');
  });
  it('returns null for Codex — no stale id baked in (OQ1)', () => {
    expect(providerDefaultModel('openai')).toBeNull();
  });
  it('returns null for Gemini — no stale id baked in (OQ1)', () => {
    expect(providerDefaultModel('gemini')).toBeNull();
  });
});

describe('providerRequiresExplicitModel', () => {
  it('does not require an explicit model for Claude', () => {
    expect(providerRequiresExplicitModel('anthropic')).toBe(false);
  });
  it('requires an explicit model for Codex and Gemini (OQ1)', () => {
    expect(providerRequiresExplicitModel('openai')).toBe(true);
    expect(providerRequiresExplicitModel('gemini')).toBe(true);
  });
});

describe('providerFromCliName', () => {
  it('maps the CLI-facing names to the internal enum', () => {
    expect(providerFromCliName('claude')).toBe('anthropic');
    expect(providerFromCliName('codex')).toBe('openai');
    expect(providerFromCliName('gemini')).toBe('gemini');
  });
  it('is case- and whitespace-insensitive', () => {
    expect(providerFromCliName('  Claude ')).toBe('anthropic');
  });
  it('throws with the valid set on an unknown name', () => {
    expect(() => providerFromCliName('anthropic')).toThrow(/Valid providers: claude, codex, gemini/);
    expect(() => providerFromCliName('bogus')).toThrow(/Invalid provider "bogus"/);
  });
  it('exposes the CLI names with claude first (the default)', () => {
    expect(PROVIDER_CLI_NAMES).toEqual(['claude', 'codex', 'gemini']);
  });
});

describe('install metadata', () => {
  it('gives every provider an install command and docs URL', () => {
    for (const p of ALL) {
      expect(PROVIDER_REGISTRY[p].installCmd).toMatch(/install/);
      expect(PROVIDER_REGISTRY[p].docsUrl).toMatch(/^https?:\/\//);
    }
  });
});

describe('providerBin', () => {
  it('resolves the default PATH bin for each provider', () => {
    // Guard against leaking overrides from the environment.
    for (const p of ALL) {
      const env = PROVIDER_REGISTRY[p].binEnvVar;
      const prev = process.env[env];
      delete process.env[env];
      try {
        expect(providerBin(p)).toBe(PROVIDER_REGISTRY[p].defaultBin);
      } finally {
        if (prev !== undefined) process.env[env] = prev;
      }
    }
  });

  it('honours the SHRENI_*_BIN override', () => {
    const prev = process.env.SHRENI_GEMINI_BIN;
    process.env.SHRENI_GEMINI_BIN = '/custom/gemini';
    try {
      expect(providerBin('gemini')).toBe('/custom/gemini');
    } finally {
      if (prev === undefined) delete process.env.SHRENI_GEMINI_BIN;
      else process.env.SHRENI_GEMINI_BIN = prev;
    }
  });
});