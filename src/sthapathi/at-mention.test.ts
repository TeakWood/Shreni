import { describe, it, expect } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

const { parseAtMention, resolveAtMentionKshetra } = await import('./at-mention.js');

function makeKshetra(id: string): KshetraConfig {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    repo: { path: `/projects/${id}`, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: `/projects/${id}-beads`, remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  };
}

// ── parseAtMention ────────────────────────────────────────────────────────────

describe('parseAtMention', () => {
  it('parses a simple @kshetra-id prefix', () => {
    const result = parseAtMention('@sishya what is the auth flow?');
    expect(result).toEqual({ kshetraId: 'sishya', text: 'what is the auth flow?' });
  });

  it('parses hyphenated kshetra ids', () => {
    const result = parseAtMention('@my-project show me the tests');
    expect(result).toEqual({ kshetraId: 'my-project', text: 'show me the tests' });
  });

  it('returns null when no @mention prefix', () => {
    expect(parseAtMention('show me the tests')).toBeNull();
  });

  it('returns null for bare @mention with no text', () => {
    expect(parseAtMention('@sishya')).toBeNull();
  });

  it('returns null when @ is not at the start', () => {
    expect(parseAtMention('hello @sishya show me tests')).toBeNull();
  });

  it('preserves multi-line text after the mention', () => {
    const input = '@sishya line one\nline two';
    const result = parseAtMention(input);
    expect(result?.text).toContain('line one');
    expect(result?.text).toContain('line two');
  });

  it('trims leading/trailing whitespace from the text portion', () => {
    const result = parseAtMention('@sishya   some text   ');
    expect(result?.text).toBe('some text');
  });
});

// ── resolveAtMentionKshetra ───────────────────────────────────────────────────

describe('resolveAtMentionKshetra', () => {
  const kshetras = [makeKshetra('sishya'), makeKshetra('mandira'), makeKshetra('vihara')];

  it('returns the matching kshetra config', () => {
    const result = resolveAtMentionKshetra('mandira', kshetras);
    expect(result?.id).toBe('mandira');
  });

  it('returns null when no kshetra matches', () => {
    expect(resolveAtMentionKshetra('unknown', kshetras)).toBeNull();
  });

  it('returns null for empty kshetra list', () => {
    expect(resolveAtMentionKshetra('sishya', [])).toBeNull();
  });

  it('matches exactly by id (no prefix match)', () => {
    expect(resolveAtMentionKshetra('si', kshetras)).toBeNull();
  });
});