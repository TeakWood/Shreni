// Shreni build identity (epic yrk / Study B2, yrk.2) — the `process.shreni`
// section of the lot manifest: which build of Shreni ran a lot.
//
// STAMPED AT BUILD TIME, read here at runtime. The operator's install is an npm
// link to the checkout, so what runs is dist/ as of the last `tsc`, NOT git HEAD
// (code can be pulled or committed without rebuilding). A runtime `git rev-parse`
// would therefore report code that is not executing. So this reader NEVER shells
// out to git and NEVER throws: it reads only what the build stamped
// (scripts/stamp-build-info.mjs → dist/build-info.json, or the __SHRENI_BUILD_INFO__
// constant esbuild embeds into the SEA binary), and on any miss falls back to the
// package version with an 'unknown' commit.

import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface BuildIdentity {
  // The package.json version. Always known (bundled with the package).
  version: string;
  // The git commit the build was cut from, or null when built outside a git
  // checkout, or the string 'unknown' when no build identity was stamped at all.
  commit: string | null;
  // Whether the working tree had uncommitted changes at build time; null when git
  // was unavailable or no identity was stamped.
  dirty: boolean | null;
  // ISO timestamp of the build; null when no identity was stamped.
  builtAt: string | null;
}

// The SEA binary bundles everything into one file with no dist/build-info.json
// beside it, so build-binary.mjs embeds the stamped identity here via esbuild
// `define`, replacing this token with a JSON string literal. In the ordinary
// (tsc) build the token is never defined, so the `typeof` guard is false and the
// reader falls through to the file. Declared so TypeScript accepts the reference.
declare const __SHRENI_BUILD_INFO__: string | undefined;

// Read the package version without git, for the fallback path. dist/sthapathi/
// build-info.js → ../../package.json is the package root; the same relative path
// resolves under src/ via tsx. Never throws.
function versionFallback(): string {
  try {
    const raw = readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Coerce an arbitrary parsed value into a well-formed BuildIdentity, filling any
// missing/mistyped field from the fallbacks. Tolerant because build-info.json is
// read years later by possibly-newer/older code.
function coerce(parsed: unknown): BuildIdentity {
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return {
    version: typeof o.version === 'string' ? o.version : versionFallback(),
    commit: typeof o.commit === 'string' || o.commit === null ? (o.commit as string | null) : null,
    dirty: typeof o.dirty === 'boolean' || o.dirty === null ? (o.dirty as boolean | null) : null,
    builtAt: typeof o.builtAt === 'string' || o.builtAt === null ? (o.builtAt as string | null) : null,
  };
}

// The Shreni build identity for this process. Prefers the SEA-embedded constant,
// then dist/build-info.json, then the unknown fallback. Synchronous, no I/O beyond
// one small file read, no git — safe to call at worker start.
export function getBuildIdentity(): BuildIdentity {
  // 1. SEA binary: the constant esbuild substituted.
  if (typeof __SHRENI_BUILD_INFO__ !== 'undefined') {
    try {
      return coerce(JSON.parse(__SHRENI_BUILD_INFO__));
    } catch {
      // A malformed embed should still not throw; fall through to the file/fallback.
    }
  }
  // 2. Stamped file beside the compiled bundle: dist/build-info.json.
  try {
    const raw = readFileSync(resolve(__dirname, '..', 'build-info.json'), 'utf8');
    return coerce(JSON.parse(raw));
  } catch {
    // 3. No identity stamped (dev via tsx, or a missing/corrupt file): version is
    // still known from package.json; commit is explicitly 'unknown' (not null,
    // which means "built outside a git checkout").
    return { version: versionFallback(), commit: 'unknown', dirty: null, builtAt: null };
  }
}
