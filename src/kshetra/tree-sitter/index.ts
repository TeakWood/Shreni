// Tree-sitter symbol extraction for the non-TS stacks in the repo map
// (Shreni-beads-l40, Tier 1 of the RAG grounding epic Shreni-beads-6m0). This is
// the public entry: it owns runtime init, the per-language parser pool, wasm
// asset resolution, and dispatch to the per-language walkers (./python.ts etc.).
//
// repo-map.ts parses TS/JS with the TypeScript compiler AST. Python/Go/Rust/Java
// get a REAL AST here via web-tree-sitter (WebAssembly), replacing the bounded
// line-regex visibility heuristic that mishandled multi-line signatures, grouped
// declarations, and receiver/impl methods.
//
// Why web-tree-sitter (wasm) and not the native `tree-sitter` bindings: the CLI
// ships as a Node SEA single-file binary (scripts/build-binary.mjs). Native
// `.node` addons don't survive a SEA, but wasm does — the runtime + grammar wasm
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
import { isStandaloneBinary } from '../../cli/self-exec.js';
import type { Node } from './common.js';
import { walk as walkTs } from './typescript.js';
import { walk as walkPython } from './python.js';
import { walk as walkGo } from './go.js';
import { walk as walkRust } from './rust.js';
import { walk as walkJava } from './java.js';

// The languages this module parses with tree-sitter. Kept separate from repo-map's
// `Lang` (which also has 'other') so the two concerns don't leak. Every parsed
// language — TS/JS included — goes through one construct here (a top-level symbol
// map, not a full compilation), rather than a bespoke path per stack.
export type TsLang = 'ts' | 'python' | 'go' | 'rust' | 'java';

// Asset/grammar basenames, one per language. The asset name embedded in the SEA
// blob and the node_modules filename share this stem so a single string drives
// both lookup paths. `ts` uses the `tsx` grammar — a superset that reads TS, JS,
// and JSX, so one grammar serves every .ts/.tsx/.js/.jsx variant.
const GRAMMAR_STEM: Record<TsLang, string> = {
  ts: 'tree-sitter-tsx',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
};

// Per-language tree walkers, keyed for dispatch.
const WALKERS: Record<TsLang, (root: Node) => string[]> = {
  ts: walkTs,
  python: walkPython,
  go: walkGo,
  rust: walkRust,
  java: walkJava,
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
    return WALKERS[lang](tree.rootNode);
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
