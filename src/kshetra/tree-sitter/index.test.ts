// Sync-guard for tree-sitter language registration (Shreni-beads-n8l.3).
//
// Adding a language means editing several places that must stay consistent: the
// `TsLang` union, the `GRAMMAR_STEM` map, and the `WALKERS` map (all in
// index.ts), plus the hard-coded SEA asset stem list in scripts/build-binary.mjs.
// A language present in some but not all of these compiles and passes under plain
// `node` (grammar bytes come from node_modules) but breaks in the shipped SEA
// binary, where the missing asset can't be read. `TsLang` is a *type*, so its
// members are invisible at runtime — this test parses the source text instead, so
// the whole invariant (union + both maps + the .mjs list) is checked in one place
// and a half-added language fails loudly here rather than in production.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const indexSrc = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
const buildSrc = readFileSync(
  fileURLToPath(new URL('../../../scripts/build-binary.mjs', import.meta.url)),
  'utf8',
);

// The single-quoted string literals inside a `{ ... }` or `[ ... ]` block.
function stringLiterals(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1]);
}

// The identifier keys of an object literal (the `key:` at the start of a line).
function objectKeys(block: string): string[] {
  return [...block.matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1]);
}

// Body of `const <NAME>: Record<TsLang, ...> = { ... };`.
function recordBody(src: string, name: string): string {
  // Non-greedy up to the `= {` that opens the literal. Not `[^=]*` — a value type
  // like `Record<TsLang, (root: Node) => string[]>` contains an `=` (in `=>`).
  const re = new RegExp(`const ${name}[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\};`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not locate ${name} object literal in index.ts`);
  return m[1];
}

// Members of `export type TsLang = 'a' | 'b' | ...;`.
function tsLangMembers(src: string): string[] {
  const m = src.match(/export type TsLang\s*=\s*([^;]+);/);
  if (!m) throw new Error('could not locate TsLang union in index.ts');
  return stringLiterals(m[1]);
}

// The stem array in `for (const stem of [ ... ])` in build-binary.mjs.
function buildStemList(src: string): string[] {
  const m = src.match(/for \(const stem of \[([\s\S]*?)\]\)/);
  if (!m) throw new Error('could not locate the stem list in scripts/build-binary.mjs');
  return stringLiterals(m[1]);
}

const asSet = (xs: string[]) => new Set(xs);

describe('tree-sitter language registration is in sync', () => {
  const tsLang = tsLangMembers(indexSrc);
  const grammarStem = recordBody(indexSrc, 'GRAMMAR_STEM');
  const walkers = recordBody(indexSrc, 'WALKERS');
  const grammarKeys = objectKeys(grammarStem);
  const walkerKeys = objectKeys(walkers);

  it('TsLang union, GRAMMAR_STEM keys, and WALKERS keys are the same set', () => {
    // Sanity: each source really did yield members (guards against a regex that
    // silently matched nothing).
    expect(tsLang.length).toBeGreaterThan(0);
    expect(asSet(grammarKeys)).toEqual(asSet(tsLang));
    expect(asSet(walkerKeys)).toEqual(asSet(tsLang));
  });

  it('every GRAMMAR_STEM value is embedded as a SEA asset in build-binary.mjs', () => {
    const stems = asSet(stringLiterals(grammarStem)); // the tree-sitter-* values
    const built = asSet(buildStemList(buildSrc));
    // Exact equality both directions: a stem in one list but not the other means
    // a language is half-registered (works under node, broken in the SEA binary).
    expect(built).toEqual(stems);
  });
});
