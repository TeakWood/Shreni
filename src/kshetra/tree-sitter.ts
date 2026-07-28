// Tree-sitter symbol extraction for the non-TS stacks in the repo map
// (Shreni-beads-l40, Tier 1 of the RAG grounding epic Shreni-beads-6m0).
//
// repo-map.ts parses TS/JS with the TypeScript compiler AST. Python/Go/Rust/Java
// /Kotlin get a REAL AST here via web-tree-sitter (WebAssembly), replacing the
// bounded line-regex visibility heuristic that mishandled multi-line signatures,
// grouped declarations, and receiver/impl methods.
//
// Why web-tree-sitter (wasm) and not the native `tree-sitter` bindings: the CLI
// ships as a Node SEA single-file binary (scripts/build-binary.mjs). Native
// `.node` addons don't survive SEA, but wasm does — the runtime + grammar wasm
// are embedded as SEA assets (see the `assets` map in build-binary.mjs) and read
// at runtime via `sea.getAsset()`. Under plain `node` (dev / npm install) the
// same bytes come from node_modules. Both paths feed the bytes to
// `Parser.init({ wasmBinary })` / `Language.load(bytes)`, so no wasm file ever
// has to be located on disk relative to the executable — the piece that makes
// this SEA-safe.
//
// Version pinning matters: web-tree-sitter@0.24.7 is the runtime whose loader ABI
// matches the prebuilt grammars in tree-sitter-wasms@0.1.13 (built with the 0.20
// tree-sitter CLI). Newer runtimes (0.25+) reject those grammars at load time.
//
// This module NEVER throws: any init/load/parse failure returns null so the
// caller falls back to the regex heuristic and the map is still produced.

import { readFileSync } from 'fs';
import Parser from 'web-tree-sitter';
import { isStandaloneBinary } from '../cli/self-exec.js';

// The languages this module parses with tree-sitter. Kept separate from repo-map's
// `Lang` (which also has 'ts' and 'other') so the two concerns don't leak.
export type TsLang = 'python' | 'go' | 'rust' | 'java' | 'kotlin';

// Asset/grammar basenames, one per language. The asset name embedded in the SEA
// blob and the node_modules filename share this stem so a single string drives
// both lookup paths.
const GRAMMAR_STEM: Record<TsLang, string> = {
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  kotlin: 'tree-sitter-kotlin',
};

// The Emscripten runtime wasm that web-tree-sitter loads before any grammar.
const RUNTIME_ASSET = 'tree-sitter.wasm';

// Read a wasm asset's bytes from whichever store this build has. In a SEA the
// bytes are embedded assets (no files on disk); under node they sit in
// node_modules. `require.resolve` is used (not a hard-coded path) so pnpm's
// nested layout and hoisting both resolve correctly.
function wasmBytes(assetName: string, resolveSpecifier: string): Uint8Array {
  if (isStandaloneBinary()) {
    // node:sea ships on Node >=20.12; getAsset returns the embedded ArrayBuffer.
    const sea = require('node:sea') as { getAsset(name: string): ArrayBuffer };
    return new Uint8Array(sea.getAsset(assetName));
  }
  return readFileSync(require.resolve(resolveSpecifier));
}

// One-time runtime init, memoised. Resolves to the Parser namespace on success or
// null once (and cached) on failure, so a broken wasm environment costs one
// attempt, not one per file.
let runtimeInit: Promise<typeof Parser | null> | null = null;

function ensureRuntime(): Promise<typeof Parser | null> {
  return (runtimeInit ??= (async () => {
    try {
      await Parser.init({ wasmBinary: wasmBytes(RUNTIME_ASSET, 'web-tree-sitter/tree-sitter.wasm') });
      return Parser;
    } catch {
      return null; // wasm runtime unavailable — caller falls back to regex
    }
  })());
}

// Per-language parser cache. Each entry is the in-flight-or-settled promise so
// concurrent files of the same language share one grammar load. A null resolution
// is cached too (failed grammar → don't retry).
const parsers = new Map<TsLang, Promise<Parser | null>>();

function getParser(lang: TsLang): Promise<Parser | null> {
  let p = parsers.get(lang);
  if (!p) {
    p = (async () => {
      const rt = await ensureRuntime();
      if (!rt) return null;
      try {
        const stem = GRAMMAR_STEM[lang];
        const bytes = wasmBytes(`${stem}.wasm`, `tree-sitter-wasms/out/${stem}.wasm`);
        const language = await rt.Language.load(bytes);
        const parser = new rt();
        parser.setLanguage(language);
        return parser;
      } catch {
        return null; // grammar failed to load — fall back for this language
      }
    })();
    parsers.set(lang, p);
  }
  return p;
}

// ── Tree walking (per language) ───────────────────────────────────────────────

type Node = Parser.SyntaxNode;

// A declaration's bound name: the `name` field where the grammar exposes one
// (python/go/rust/java), else the first identifier child (kotlin's older grammar
// has no `name` field on its declarations).
function nameText(node: Node): string | null {
  const field = node.childForFieldName('name');
  if (field) return field.text;
  for (const c of node.namedChildren) {
    if (c.type === 'identifier' || c.type === 'simple_identifier' || c.type === 'type_identifier') {
      return c.text;
    }
  }
  return null;
}

// True when a node carries a `visibility_modifier` child (Rust's `pub`, incl.
// `pub(crate)` — matched broadly, as the prior regex did).
function hasVisibilityModifier(node: Node): boolean {
  return node.namedChildren.some(c => c.type === 'visibility_modifier');
}

// The text of a node's `modifiers` child (Java/Kotlin), or '' when absent.
function modifiersText(node: Node): string {
  const mods = node.namedChildren.find(c => c.type === 'modifiers');
  return mods ? mods.text : '';
}

// Go: a top-level identifier is exported iff it begins with an uppercase letter.
function isGoExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function walkPython(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    // `@decorator`-wrapped defs sit under decorated_definition.definition.
    const def = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (!def) continue;
    if (def.type === 'function_definition' || def.type === 'class_definition') {
      const name = nameText(def);
      // Leading underscore is Python's private convention.
      if (name && !name.startsWith('_')) out.push(name);
    }
  }
  return out;
}

function walkGo(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'function_declaration':
      case 'method_declaration': {
        const name = nameText(child);
        if (name && isGoExported(name)) out.push(name);
        break;
      }
      // `type (...)`, `var (...)`, `const (...)` group one spec per declared name.
      case 'type_declaration':
      case 'var_declaration':
      case 'const_declaration':
        for (const spec of child.namedChildren) {
          const name = nameText(spec);
          if (name && isGoExported(name)) out.push(name);
        }
        break;
    }
  }
  return out;
}

// Rust top-level items and the public members of `impl`/`mod` blocks (the latter
// is where a type's public API usually lives — the line regex caught them by
// accident, this catches them by structure).
function walkRust(root: Node): string[] {
  const out: string[] = [];
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'impl_item' || child.type === 'mod_item') {
        const body = child.childForFieldName('body');
        if (body) visit(body);
        continue;
      }
      if (hasVisibilityModifier(child)) {
        const name = nameText(child);
        if (name) out.push(name);
      }
    }
  };
  visit(root);
  return out;
}

function walkJava(root: Node): string[] {
  const out: string[] = [];
  const TYPES = new Set([
    'class_declaration', 'interface_declaration', 'enum_declaration',
    'record_declaration', 'annotation_type_declaration',
  ]);
  for (const child of root.namedChildren) {
    if (!TYPES.has(child.type)) continue;
    if (!modifiersText(child).includes('public')) continue;
    const name = nameText(child);
    if (name) out.push(name);
  }
  return out;
}

// Kotlin defaults to public visibility, so a top-level declaration is public
// unless it carries a private/protected/internal modifier.
function walkKotlin(root: Node): string[] {
  const out: string[] = [];
  const TYPES = new Set(['function_declaration', 'class_declaration', 'object_declaration']);
  for (const child of root.namedChildren) {
    if (!TYPES.has(child.type)) continue;
    const mods = modifiersText(child);
    if (/\b(private|protected|internal)\b/.test(mods)) continue;
    const name = nameText(child);
    if (name) out.push(name);
  }
  return out;
}

function walk(lang: TsLang, root: Node): string[] {
  switch (lang) {
    case 'python': return walkPython(root);
    case 'go': return walkGo(root);
    case 'rust': return walkRust(root);
    case 'java': return walkJava(root);
    case 'kotlin': return walkKotlin(root);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Extract exported/public top-level symbol names from `content`, parsed as `lang`
// with tree-sitter. Returns the names in source order (deduping/bounding is the
// caller's job), or null when tree-sitter is unavailable or the parse failed —
// the null signal tells the caller to fall back to its regex heuristic so the
// repo map is produced regardless.
export async function extractSymbolsTreeSitter(content: string, lang: TsLang): Promise<string[] | null> {
  const parser = await getParser(lang);
  if (!parser) return null;
  let tree: Parser.Tree | null = null;
  try {
    tree = parser.parse(content);
    return walk(lang, tree.rootNode);
  } catch {
    return null;
  } finally {
    tree?.delete();
  }
}

// Test/diagnostic hook: report whether the tree-sitter runtime initialised. Lets
// tests assert the wasm path is actually exercised (not silently falling back).
export async function treeSitterAvailable(): Promise<boolean> {
  return (await ensureRuntime()) !== null;
}
