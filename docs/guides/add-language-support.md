# Adding Language Support

How to teach Shreni about a new programming language — so its repo map extracts
real symbols from that language's files, its automation gates (build/test/lint)
run the right commands, and — optionally — `shreni init` can scaffold projects in
it.

Support for a language is spread across **three independent seams**, plus one
thing that is deliberately *not* a seam (`kshetra.yaml`). You can land them one at
a time: a language with a toolchain profile but no repo-map walker still runs its
gates; a language with a repo-map walker but no profile still gets AST symbols.
Nothing forces you to do all of it at once.

Adding a language is a distinct kind of extension from the optional
capability-package seams (`EventSink` / `UsageMeter` / `PolicySource` /
`Entitlements`) described in
[docs/architecture/extension-points.md](../architecture/extension-points.md) —
those add capability *around* the core without touching it; a language edits the
core directly, at the three seams below. This guide walks a single worked example —
**adding Ruby** — end to end, then distils a language-agnostic checklist and the
footguns to avoid.

> **The Ruby example is illustrative and is _not_ merged into the codebase.** It
> is written out in full so you can see every touch-point; the snippets are
> copy-paste-ready for a real language, but Ruby itself is not wired up here.

---

## The four-row seam model

| Row | Seam | Required? | What it buys you |
|-----|------|-----------|------------------|
| 1 | **repo-map** (tree-sitter AST) | Required *for symbols* | A file in the language yields real top-level symbol names in the repo map, not just a file listing. Without it the file is still listed, but with no symbols. |
| 2 | **toolchain profile** | Required *for gates* | `build` / `test` / `lint` / `coverage` resolve to the right commands so Viharapala, health checks, and Parikshaka actually run against the language. Without it the language falls to the `unknown` profile — every gate skips (visible warn). |
| 3 | **init-pack** | Optional | `shreni init` can suggest and scaffold a per-stack pack (style guide, arch note, review rubric). Pure data; no code. |
| — | **`kshetra.yaml`** | **No change ever** | `stack.language` is a free-form string. Adding a language needs **no schema change** — see below. |

Rows 1 and 2 are independent: do them in either order. Row 3 is optional and can
come much later, if at all.

---

## `kshetra.yaml` needs no schema change

`stack.language` is a free-form `z.string()` — see `StackConfigSchema` at
[src/kshetra/config.ts:35](../../src/kshetra/config.ts). You never edit the schema
to add a language. The string is *resolved*, not enumerated:

- **For gates**, `normalizeLanguage()` maps the free-form string onto a
  `ProfileKey` ([src/kshetra/toolchain.ts:25](../../src/kshetra/toolchain.ts)).
  Unrecognised strings fall to `'unknown'` (skip-and-warn), never a wrong `pnpm`
  command.
- **For symbols**, the repo map picks a parser per file *by extension*, not by the
  Kshetra's declared language (`languageOf()` /
  [src/kshetra/repo-map.ts:58](../../src/kshetra/repo-map.ts)) — so a mixed repo is
  handled file by file.

**Precedence** (highest wins): an explicit `stack.*` value in `kshetra.yaml` →
pack value → language-profile default. `stack.*` overrides everything
([src/kshetra/toolchain.ts:107](../../src/kshetra/toolchain.ts) `resolveCommand`);
the pack fills gaps at init time
([src/kshetra/packs.ts:137](../../src/kshetra/packs.ts) `mergeStack`); the profile
default is the last resort at runtime. An explicit `""` means "skip this gate on
purpose" and is honoured — it is not treated as unset.

---

## Worked example: adding Ruby

Ruby is a convenient example because its tree-sitter grammar
(`tree-sitter-ruby.wasm`) is **already bundled** in `tree-sitter-wasms@0.1.13` —
so Seam 1 needs no new dependency and no wasm build, only registration. Always
check `node_modules/tree-sitter-wasms/out/` for `tree-sitter-<lang>.wasm` before
assuming you need to add a grammar dep (see the footguns).

### Seam 1 — repo-map (required for symbols)

**a. Write the walker.** A walker takes the parsed tree's root `Node` and returns
the public/top-level symbol names in source order. Model it on an existing one —
`python.ts` is the simplest ([src/kshetra/tree-sitter/python.ts](../../src/kshetra/tree-sitter/python.ts)).
Use the shared helpers in `common.ts` (`nameText`, `hasVisibilityModifier`,
`modifiersText`) rather than reaching into node internals.

Create `src/kshetra/tree-sitter/ruby.ts`:

```ts
// Ruby symbol walk: top-level method/class/module definitions.

import { type Node, nameText } from './common.js';

export function walk(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'method' || child.type === 'class' || child.type === 'module') {
      const name = nameText(child);
      if (name) out.push(name);
    }
  }
  return out;
}
```

> Grammar node type names (`method`, `class`, `module`, …) come from the language's
> tree-sitter grammar, not from us. Confirm them against the grammar's
> `node-types.json` or by printing `node.type` while iterating during development.

**b. Register the walker** in [src/kshetra/tree-sitter/index.ts](../../src/kshetra/tree-sitter/index.ts).
Three edits, all of which must move together (a sync-guard test enforces this —
see Seam-1 footgun):

```ts
// 1. TsLang union (index.ts:42)
export type TsLang = 'ts' | 'python' | 'go' | 'rust' | 'java' | 'ruby';

// 2. GRAMMAR_STEM (index.ts:48) — the wasm basename, shared by the SEA asset
//    key and the node_modules path.
const GRAMMAR_STEM: Record<TsLang, string> = {
  ts: 'tree-sitter-tsx',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  ruby: 'tree-sitter-ruby',
};

// 3. WALKERS (index.ts:57) — plus the import at the top of the file.
import { walk as walkRuby } from './ruby.js';
// ...
const WALKERS: Record<TsLang, (root: Node) => string[]> = {
  ts: walkTs, python: walkPython, go: walkGo, rust: walkRust, java: walkJava,
  ruby: walkRuby,
};
```

**c. Map the extension(s) to the language** in [src/kshetra/repo-map.ts](../../src/kshetra/repo-map.ts):

```ts
// EXT_LANG (repo-map.ts:58) — file extension → the Lang it is parsed AS.
const EXT_LANG: Record<string, Lang> = {
  // ...existing entries...
  '.rb': 'ruby',
};

// SOURCE_EXTENSIONS (repo-map.ts:37) — which files the map walks per profile.
// Add '.rb' to the `ruby` profile's set (created in Seam 2). Until Seam 2 lands,
// '.rb' still parses under the `unknown` profile, which already includes '.rb'.
```

Also extend the `Lang` union at [repo-map.ts:56](../../src/kshetra/repo-map.ts) to
include `'ruby'`.

**d. Add a regex fallback arm** in `extractSymbolsRegex()`
([src/kshetra/repo-map.ts:217](../../src/kshetra/repo-map.ts)). This is the
line-based heuristic used when the wasm runtime can't load — less accurate than the
AST, but it keeps the map non-empty:

```ts
case 'ruby': {
  const m = line.match(/^\s*(?:def|class|module)\s+([A-Za-z_]\w*[!?]?)/);
  if (m) out.push(m[1]);
  break;
}
```

**e. Register the wasm as a SEA asset.** The CLI ships as a Node single-file
executable; grammar wasm is embedded as a SEA asset. Add the stem to the
hard-coded list in [scripts/build-binary.mjs:77](../../scripts/build-binary.mjs):

```js
for (const stem of ['tree-sitter-tsx', 'tree-sitter-python', 'tree-sitter-go',
                    'tree-sitter-rust', 'tree-sitter-java', 'tree-sitter-ruby']) {
  assets[`${stem}.wasm`] = require.resolve(`tree-sitter-wasms/out/${stem}.wasm`);
}
```

> **This list is hand-synced with `GRAMMAR_STEM`.** Miss it and Ruby works under
> plain `node` (bytes come from `node_modules`) but the language silently loses its
> grammar in the SEA binary. See the footgun below — and the sync-guard test that
> catches exactly this.

**f. Add a test** in `src/kshetra/repo-map.test.ts` asserting a `.rb` fixture
yields the expected symbols via tree-sitter.

**If the grammar were *not* already bundled** (unlike Ruby), you would also add the
grammar as a dependency — either a `tree-sitter-wasms` version that includes it, or
a standalone `tree-sitter-<lang>.wasm` package resolvable at
`tree-sitter-wasms/out/<stem>.wasm` — matching the ABI expected by
`web-tree-sitter@0.24.7` (see the version-pinning note in `index.ts`).

### Seam 2 — toolchain profile (required for gates)

Two files. In [src/kshetra/toolchain.ts](../../src/kshetra/toolchain.ts):

```ts
// 1. ProfileKey (toolchain.ts:11)
export type ProfileKey = 'node' | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'unknown';

// 2. normalizeLanguage alias arm (toolchain.ts:25) — accept the spellings a
//    kshetra.yaml might use.
if (['ruby', 'rb'].includes(l)) return 'ruby';

// 3. STATIC_PROFILES entry (toolchain.ts:37) — the command family + globs.
ruby: {
  build: '',                       // most Ruby projects have no build step
  test: 'bundle exec rspec',
  lint: 'bundle exec rubocop',
  coverage: '',                    // SimpleCov is opt-in; skip by default
  testFileGlobs: ['*_spec.rb', 'test_*.rb'],
  vendorDirs: ['vendor', '.bundle'],
},
```

Then add the marker-file detection arm in `detectToolchain()`
([src/cli/detect-toolchain.ts:75](../../src/cli/detect-toolchain.ts)) so
`shreni init` recognises a Ruby repo:

```ts
if (existsSync(join(repoPath, 'Gemfile'))) {
  return { language: 'ruby', unknown: false };
}
```

Finally, add the `ruby` profile's source extensions to `SOURCE_EXTENSIONS` in
repo-map.ts (`ruby: new Set(['.rb'])`) — the Seam-1 step (c) referenced this.

### Seam 3 — init-pack (optional)

Packs are **data only** — no code. Create `packs/ruby-rspec/` with:

- `pack.yaml` — `stack` defaults + an optional `detect` block (scored hints such
  as `files: ['Gemfile', '.rubocop.yml']`). The `detect` schema is `DetectSchema`
  at [src/kshetra/packs.ts:16](../../src/kshetra/packs.ts); scoring lives in
  `scorePackDetect()` ([src/cli/detect-toolchain.ts:119](../../src/cli/detect-toolchain.ts)).
- `style-guide.md`, `arch.md`, `review-guide.md`, and any `reference/` material.

`listPacks()` auto-discovers the directory — no registration call. At init the pack
suggestion is scored against the repo and the pack's `stack.*` values merge over
the profile defaults (but under explicit user `stack.*`).

### `kshetra.yaml` — nothing to do

A Ruby project's config is just:

```yaml
stack:
  language: ruby      # resolves to the ruby ProfileKey; free-form string
```

No schema edit, no enum entry. If the project wants a non-default test runner it
sets `stack.testRunner` and that wins over the profile — but that is per-project
config, not part of adding the language.

---

## Touch-point table

Every file you edit to add a language, with line anchors (verify against `HEAD` —
line numbers drift):

| Seam | File | Anchor | Edit |
|------|------|--------|------|
| 1 | `src/kshetra/tree-sitter/<lang>.ts` | new file | `walk(root)` returning symbol names |
| 1 | `src/kshetra/tree-sitter/index.ts` | `:42` | add member to `TsLang` union |
| 1 | `src/kshetra/tree-sitter/index.ts` | `:48` | add `GRAMMAR_STEM` entry |
| 1 | `src/kshetra/tree-sitter/index.ts` | `:57` + import | add `WALKERS` entry |
| 1 | `src/kshetra/repo-map.ts` | `:56` | add member to `Lang` union |
| 1 | `src/kshetra/repo-map.ts` | `:58` | add `EXT_LANG` extension mapping |
| 1 | `src/kshetra/repo-map.ts` | `:37` | add extensions to `SOURCE_EXTENSIONS[<lang>]` |
| 1 | `src/kshetra/repo-map.ts` | `:217` | add `case` arm to `extractSymbolsRegex()` |
| 1 | `scripts/build-binary.mjs` | `:77` | add stem to the SEA asset list **(hand-synced with `GRAMMAR_STEM`)** |
| 1 | `src/kshetra/repo-map.test.ts` | — | fixture asserting symbols extract |
| 2 | `src/kshetra/toolchain.ts` | `:11` | add member to `ProfileKey` |
| 2 | `src/kshetra/toolchain.ts` | `:25` | add alias arm to `normalizeLanguage()` |
| 2 | `src/kshetra/toolchain.ts` | `:37` | add `STATIC_PROFILES` entry |
| 2 | `src/cli/detect-toolchain.ts` | `:75` | add marker-file arm to `detectToolchain()` |
| 3 (opt) | `packs/<name>/` | new dir | `pack.yaml` + guide docs; auto-discovered |
| — | `kshetra.yaml` | — | **no change** |

---

## Language-agnostic checklist

For any language, in order:

- [ ] **Grammar available?** Check `node_modules/tree-sitter-wasms/out/` for
      `tree-sitter-<lang>.wasm`. If absent, add a grammar dep whose ABI matches
      `web-tree-sitter@0.24.7` before proceeding.
- [ ] **Walker** — `src/kshetra/tree-sitter/<lang>.ts` with a `walk(root): string[]`,
      built on `common.ts` helpers and modelled on an existing walker.
- [ ] **Register the walker** — `TsLang`, `GRAMMAR_STEM`, `WALKERS` (+ import) in
      `index.ts`. All three, together.
- [ ] **Map extensions** — `Lang` union, `EXT_LANG`, and `SOURCE_EXTENSIONS` in
      `repo-map.ts`.
- [ ] **Regex fallback** — a `case` arm in `extractSymbolsRegex()`.
- [ ] **SEA asset** — add the stem to the list in `scripts/build-binary.mjs`
      (must match `GRAMMAR_STEM`).
- [ ] **Toolchain profile** — `ProfileKey`, `normalizeLanguage()` alias arm, and a
      `STATIC_PROFILES` entry in `toolchain.ts`.
- [ ] **Detection** — a marker-file arm in `detectToolchain()`.
- [ ] **Tests** — a repo-map fixture (symbols extract) and, if you added a profile,
      a toolchain resolution test.
- [ ] **(Optional) Pack** — `packs/<name>/` with `pack.yaml` + guides.
- [ ] **`pnpm build` + `pnpm test`** — including a SEA build if you can, so the
      grammar-in-binary path is exercised, not just the `node` path.

---

## Footguns

**`build-binary.mjs` ↔ `GRAMMAR_STEM` are hand-synced.** The SEA asset list at
[scripts/build-binary.mjs:77](../../scripts/build-binary.mjs) is a separate
hard-coded array from `GRAMMAR_STEM` in `index.ts`. A "half-added" language —
registered in `index.ts` but missing from the asset list — **passes every test
under plain `node`** (grammar bytes come from `node_modules`) and only breaks in
the shipped SEA binary, where `sea.getAsset()` can't find the embedded wasm. The
sync-guard test in `src/kshetra/tree-sitter/index.test.ts` exists to catch this;
keep the two lists identical.

**Check for a bundled grammar before adding a dependency.** `tree-sitter-wasms`
bundles many grammars already (Ruby, among others). Adding a redundant grammar dep
— or worse, one built against a different tree-sitter ABI — wastes effort and can
fail to load at runtime (`web-tree-sitter@0.24.7` rejects grammars from newer CLIs).
Look in `node_modules/tree-sitter-wasms/out/` first.

**Listed ≠ parsed.** `SOURCE_EXTENSIONS` (which files the walk *lists*) and
`EXT_LANG` (which language a file is *parsed as*) are different maps and can
legitimately diverge. Today `SOURCE_EXTENSIONS[java]` includes `.kt`, but `.kt` is
absent from `EXT_LANG` — so Kotlin files are listed in the map with a role but get
**no symbols** (they fall through `languageOf()` to `'other'`). If you want a file
extension to produce symbols, it must be in **both** maps.

**The walkers never throw.** The tree-sitter module returns `null` on any
init/load/parse failure so the caller falls back to the regex heuristic and the map
is still produced. Don't add throwing paths to a walker — return the names you
found and let malformed input degrade to the fallback.
