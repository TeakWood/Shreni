import { readFile, writeFile, rename, mkdir, readdir } from 'fs/promises';
import { join, relative, dirname, extname, basename } from 'path';
import ts from 'typescript';
import type { KshetraConfig } from './config.js';
import { normalizeLanguage, resolveVendorDirs, resolveTestGlobs, matchesTestGlob, type ProfileKey } from './toolchain.js';
import { extractSymbolsTreeSitter, type TsLang } from './tree-sitter/index.js';

// Deterministic repo/symbol map for agentic-retrieval cold-start (Shreni-beads-vcz,
// Tier 0 of the RAG review epic Shreni-beads-6m0). The executors are the Claude
// Code CLI running agentically — they retrieve with native Read/Grep/Glob, so
// they don't need pre-chosen chunks; they need a MAP to aim their first search
// at. This module walks the repo source tree with NO LLM and NO network,
// extracts each module's exported symbols and a one-line role (its leading
// comment), and renders a bounded markdown index. It is injected where the old
// ragChunks stub sat (dispatch.buildAgentContext) and regenerated post-merge so
// it is never misleadingly stale.

// Where the generated map is cached, relative to repo root. `.shreni/` is the
// per-Kshetra home (kshetra.yaml lives here too), so the map ships with the repo
// and every round reads the same on-disk snapshot.
const MAP_RELATIVE_PATH = '.shreni/repo-map.md';

// Prompt-budget guards (acceptance criterion: never blow the budget on large
// repos). Rendering stops once MAX_BYTES is reached; a truncation note tells the
// agent the map is partial so it doesn't assume the listing is exhaustive.
const MAX_BYTES = 24_000;
const MAX_FILES = 600;
const MAX_SYMBOLS_PER_FILE = 40;
const ROLE_MAX_CHARS = 100;

// Directory names always skipped regardless of the stack's vendorDirs — VCS,
// dependency, and Shreni's own metadata dirs never belong in a source map.
const ALWAYS_SKIP_DIRS = new Set(['.git', '.shreni', '.beads', '.hg', '.svn']);

// Source-file extensions per profile. The map lists only these; docs, lockfiles,
// and assets are excluded so it stays a code index. `unknown` gets a broad set
// so an unconfigured Kshetra still produces a useful map.
const SOURCE_EXTENSIONS: Record<ProfileKey, Set<string>> = {
  node: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']),
  python: new Set(['.py', '.pyi']),
  go: new Set(['.go']),
  rust: new Set(['.rs']),
  java: new Set(['.java', '.kt']),
  unknown: new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.h', '.cpp', '.cs']),
};

interface FileEntry {
  relPath: string;
  role: string;
  symbols: string[];
}

// The language a file is parsed AS, chosen by extension (not by the Kshetra's
// profile, so an `unknown`-profile repo with mixed sources is still handled
// per-file). `ts` covers JS too — the TypeScript parser reads plain JS. `other`
// gets a file listing + role but no symbols (e.g. .kt, until Kotlin support lands).
type Lang = 'ts' | 'python' | 'go' | 'rust' | 'java' | 'other';

const EXT_LANG: Record<string, Lang> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java',
};

function languageOf(relPath: string): Lang {
  return EXT_LANG[extname(relPath)] ?? 'other';
}

// ── Walk ────────────────────────────────────────────────────────────────────

// Collect repo-relative source-file paths, deterministically ordered (sorted) so
// the rendered map is byte-stable across regenerations — a stable map produces a
// clean git diff and a cache the next round can trust. Vendor/test files and any
// entry we can't read are skipped, never fatal.
async function collectSourceFiles(
  root: string,
  sourceExts: Set<string>,
  vendorDirs: Set<string>,
  testGlobs: string[],
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't fail the whole map
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(e.name) || vendorDirs.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile() && sourceExts.has(extname(e.name))) {
        const rel = relative(root, abs);
        // Skip test files: the map indexes source structure, and tests would
        // both bloat it and dilute the "where does X live" signal.
        if (matchesTestGlob(rel, testGlobs)) continue;
        out.push(rel);
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

// ── Role extraction (leading comment) ─────────────────────────────────────────

// Derive a one-line module role from the file's leading comment, deterministically
// (no LLM). Handles `/** … */` / `/* … */` blocks and runs of `//` (TS/JS/Go/Rust
// /Java) and `#` / `"""…"""` (Python). Returns '' when the file opens with code,
// so files without a header comment simply carry no role.
function extractRole(content: string, lang: Lang): string {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return '';
  const first = lines[i].trim();

  let raw = '';
  if ((lang === 'python') && (first.startsWith('"""') || first.startsWith("'''"))) {
    const q = first.slice(0, 3);
    // Single-line docstring, or first line of a multi-line one.
    const oneLine = first.length > 3 && first.endsWith(q) && first.length > 5;
    raw = oneLine ? first.slice(3, -3).trim() : first.slice(3).trim();
    if (!raw) {
      // docstring opened on its own line — take the next non-empty line
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t) { raw = t.replace(/['"]{3}\s*$/, '').trim(); break; }
        if (j > i + 6) break;
      }
    }
  } else if (lang === 'python' && first.startsWith('#')) {
    raw = collectLineComments(lines, i, /^#+/);
  } else if (first.startsWith('/**') || first.startsWith('/*')) {
    raw = collectBlockComment(lines, i);
  } else if (first.startsWith('//')) {
    raw = collectLineComments(lines, i, /^\/\/+/);
  }

  return normalizeRole(raw);
}

// Join a run of consecutive line-comment lines starting at `start` into one
// string, until the first non-comment (or blank) line.
function collectLineComments(lines: string[], start: number, prefix: RegExp): string {
  const parts: string[] = [];
  for (let j = start; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!prefix.test(t)) break;
    const body = t.replace(prefix, '').trim();
    if (body) parts.push(body);
    // Stop once we have enough for a one-liner — keeps large banner comments cheap.
    if (parts.join(' ').length >= ROLE_MAX_CHARS) break;
  }
  return parts.join(' ');
}

// Join the body of a `/* … */` block comment (single or multi line) into one
// string, stripping leading `*` gutters.
function collectBlockComment(lines: string[], start: number): string {
  const parts: string[] = [];
  for (let j = start; j < lines.length; j++) {
    let t = lines[j].trim();
    if (j === start) t = t.replace(/^\/\*+/, '');
    const closed = t.includes('*/');
    t = t.replace(/\*\/.*$/, '').replace(/^\*+/, '').trim();
    if (t) parts.push(t);
    if (closed) break;
    if (parts.join(' ').length >= ROLE_MAX_CHARS) break;
  }
  return parts.join(' ');
}

// Collapse whitespace, drop common doc tags/markers, and truncate to one short line.
function normalizeRole(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  // A leading @tag (@fileoverview, @module, @packageDocumentation) is noise.
  s = s.replace(/^@\w+\s*/, '').trim();
  if (s.length > ROLE_MAX_CHARS) s = s.slice(0, ROLE_MAX_CHARS - 1).trimEnd() + '…';
  return s;
}

// ── Symbol extraction (language-aware) ────────────────────────────────────────

// Cap and de-duplicate a raw symbol list, preserving first-appearance order so
// the rendered map is deterministic across regenerations.
function boundedUnique(raw: string[]): string[] {
  const names: string[] = [];
  for (const n of raw) {
    if (n && !names.includes(n) && names.length < MAX_SYMBOLS_PER_FILE) names.push(n);
  }
  return names;
}

// Extract exported/public top-level symbol names from a file, dispatched by the
// file's language. TS/JS uses the TypeScript compiler's AST (accurate across
// multi-line declarations, `export { … as … }` lists, default exports, and
// re-exports — cases a line regex mishandles). Python/Go/Rust/Java use a
// real tree-sitter AST (Shreni-beads-l40); if the wasm runtime is unavailable in
// this environment, they degrade to the bounded line-regex heuristic so the map
// is still produced. Order of first appearance is preserved and duplicates
// dropped → deterministic.
async function extractSymbols(content: string, relPath: string): Promise<string[]> {
  const lang = languageOf(relPath);
  if (lang === 'ts') return boundedUnique(extractTsSymbols(content, relPath));
  if (lang === 'other') return [];

  const viaTreeSitter = await extractSymbolsTreeSitter(content, lang);
  return boundedUnique(viaTreeSitter ?? extractSymbolsRegex(content, lang));
}

// Fallback symbol extraction for the tree-sitter languages when the wasm runtime
// can't load. A bounded per-line visibility heuristic — less accurate than the
// AST (misses multi-line signatures, grouped decls, and receiver/impl methods),
// but it keeps the map non-empty rather than dropping every non-TS symbol.
function extractSymbolsRegex(content: string, lang: TsLang): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    switch (lang) {
      case 'python': {
        // Top-level (column 0) def/class; underscore-prefixed names are private.
        const m = line.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/);
        if (m && !m[1].startsWith('_')) out.push(m[1]);
        break;
      }
      case 'go': {
        const m = line.match(/^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Za-z_]\w*)/);
        // Exported Go identifiers start with an uppercase letter.
        if (m && /^[A-Z]/.test(m[1])) out.push(m[1]);
        break;
      }
      case 'rust': {
        const m = line.match(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+([A-Za-z_]\w*)/);
        if (m) out.push(m[1]);
        break;
      }
      case 'java': {
        const m = line.match(/^\s*public\s+(?:final\s+|abstract\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/);
        if (m) out.push(m[1]);
        break;
      }
    }
  }
  return out;
}

// Choose the TypeScript ScriptKind so JSX/TSX and plain JS parse correctly.
function scriptKindFor(relPath: string): ts.ScriptKind {
  switch (extname(relPath)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

// True when `node` carries the given modifier keyword (export/default). Uses the
// public factory helpers so it is robust to the AST's internal modifier shape.
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods && mods.some(m => m.kind === kind);
}

// Walk a TS/JS source file's top-level statements and return each EXPORTED
// symbol's name. Parsing is tolerant (createSourceFile never throws on syntax
// errors — it yields a best-effort tree), so a malformed file degrades to fewer
// symbols rather than failing the whole map.
function extractTsSymbols(content: string, relPath: string): string[] {
  const names: string[] = [];
  const add = (n?: string | null): void => {
    if (n) names.push(n);
  };
  let src: ts.SourceFile;
  try {
    src = ts.createSourceFile(basename(relPath), content, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKindFor(relPath));
  } catch {
    return names; // parser refused the file — skip its symbols, keep the file listed
  }

  // Recursively collect names bound by a declaration (handles destructuring:
  // `export const { a, b } = …`, `export const [x] = …`).
  const collectBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) { add(name.text); return; }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBinding(el.name);
    }
  };

  for (const stmt of src.statements) {
    const isExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);

    if (
      ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) || ts.isModuleDeclaration(stmt)
    ) {
      if (!isExported) continue;
      // A named declaration reports its name; an anonymous default export
      // (`export default function () {}`) is listed as "default".
      add(stmt.name && ts.isIdentifier(stmt.name) ? stmt.name.text : isDefault ? 'default' : undefined);
    } else if (ts.isVariableStatement(stmt)) {
      if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
      for (const decl of stmt.declarationList.declarations) collectBinding(decl.name);
    } else if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause;
      if (!clause) add('* (re-export)'); // export * from '…'
      else if (ts.isNamespaceExport(clause)) add(clause.name.text); // export * as ns from '…'
      else for (const el of clause.elements) add(el.name.text); // export { a, b as c }
    } else if (ts.isExportAssignment(stmt)) {
      add('default'); // export default <expr>  /  export = <expr>
    }
  }
  return names;
}

// ── Render ────────────────────────────────────────────────────────────────────

// Render the collected entries as bounded markdown, grouped by directory. Adds
// entries until MAX_BYTES is reached, then stops and appends a truncation note so
// the agent knows the listing is partial (no silent cap).
function renderMap(entries: FileEntry[], projectName: string): string {
  const header =
    `# Repo Map — ${projectName}\n\n` +
    `Deterministic index of source files, their exported/public symbols, and a\n` +
    `one-line role (each module's leading comment). Regenerated on merge. Use it to\n` +
    `aim your first Read/Grep/Glob — it is a map to search, not a substitute for\n` +
    `reading the code, and it omits tests and generated files.\n`;

  // Group by directory so each header appears exactly once. Entries arrive
  // path-sorted, but a parent dir's own files sort after its subdirs, so a
  // streaming "header on dir change" would repeat headers — grouping first keeps
  // each directory's files contiguous under one heading.
  const byDir = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const dir = dirname(entry.relPath);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(entry);
  }
  const dirs = [...byDir.keys()].sort((a, b) => a.localeCompare(b));

  const lines: string[] = [header];
  let bytes = Buffer.byteLength(header, 'utf8');
  let rendered = 0;
  let truncated = false;

  outer: for (const dir of dirs) {
    let headerWritten = false;
    for (const entry of byDir.get(dir)!) {
      const chunk: string[] = [];
      if (!headerWritten) chunk.push(`\n## ${dir === '.' ? '(root)' : dir}\n`);
      const name = basename(entry.relPath);
      chunk.push(entry.role ? `- \`${name}\` — ${entry.role}` : `- \`${name}\``);
      if (entry.symbols.length) chunk.push(`  exports: ${entry.symbols.join(', ')}`);
      const text = chunk.join('\n') + '\n';
      const size = Buffer.byteLength(text, 'utf8');
      if (bytes + size > MAX_BYTES) { truncated = true; break outer; }
      lines.push(text);
      bytes += size;
      headerWritten = true;
      rendered++;
    }
  }

  if (truncated || rendered < entries.length) {
    lines.push(
      `\n_Map truncated at ${rendered}/${entries.length} files to fit the prompt budget. ` +
        `Grep for anything not listed._\n`,
    );
  }

  return lines.join('');
}

// ── Public API ────────────────────────────────────────────────────────────────

// Build the repo map from the current source tree and cache it to
// `.shreni/repo-map.md`, returning the rendered markdown. Deterministic: no LLM,
// no network. Never throws — on any failure it returns '' so a caller can omit
// the section cleanly (the map is an optimisation, never a gate). The write is
// atomic (temp file + rename) so a concurrent reader never sees a torn file.
export async function generateRepoMap(kshetra: KshetraConfig): Promise<string> {
  try {
    const root = kshetra.repo.path;
    const key = normalizeLanguage(kshetra.stack.language);
    const sourceExts = SOURCE_EXTENSIONS[key];
    const vendorDirs = new Set(resolveVendorDirs(kshetra));
    const testGlobs = resolveTestGlobs(kshetra);

    const files = (await collectSourceFiles(root, sourceExts, vendorDirs, testGlobs)).slice(0, MAX_FILES);

    const entries: FileEntry[] = [];
    for (const rel of files) {
      let content: string;
      try {
        content = await readFile(join(root, rel), 'utf8');
      } catch {
        continue; // unreadable file — skip
      }
      const lang = languageOf(rel);
      entries.push({ relPath: rel, role: extractRole(content, lang), symbols: await extractSymbols(content, rel) });
    }

    if (entries.length === 0) return '';

    const map = renderMap(entries, kshetra.name);

    const dest = join(root, MAP_RELATIVE_PATH);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, map, 'utf8');
    await rename(tmp, dest);

    return map;
  } catch {
    return '';
  }
}

// Return the repo map for injection into buildAgentContext. Reads the cached
// `.shreni/repo-map.md`; if it is absent (first run before any merge has
// regenerated it), builds it once so the cold start always has a map. Never
// throws — returns '' so Silpi's truthiness guard omits the section.
export async function loadRepoMap(kshetra: KshetraConfig): Promise<string> {
  try {
    return await readFile(join(kshetra.repo.path, MAP_RELATIVE_PATH), 'utf8');
  } catch {
    return generateRepoMap(kshetra);
  }
}

// Fire-and-forget regeneration for the post-merge hook: refresh the cached map
// after a bead merges to main so the next bead's cold start sees current
// structure, without blocking the agent loop. Errors are swallowed (best-effort
// optimisation); the atomic write in generateRepoMap keeps concurrent reads safe.
export function regenerateRepoMapAsync(kshetra: KshetraConfig): void {
  void generateRepoMap(kshetra).catch(() => {
    /* best-effort: a stale/absent map only costs the next cold start a guess */
  });
}
