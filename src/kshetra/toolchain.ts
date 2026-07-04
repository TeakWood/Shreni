import type { KshetraConfig } from './config.js';

// The single home for ecosystem defaults (the toolchain design §3.1). Every automation
// gate — build (Viharapala), test (health), lint, and Parikshaka's test-file
// discovery — resolves its command/globs here instead of applying its own
// `|| 'pnpm …'` literal. Project config is primary: a value set in stack.* wins;
// where stack is silent, a language-aware default fills the gap. An explicitly
// empty command ("") means the gate is skipped on purpose (logged, not silently
// passed), so "no gate" is a visible decision rather than an accident.

export type ProfileKey = 'node' | 'python' | 'go' | 'rust' | 'java' | 'unknown';

interface Profile {
  build: string;
  test: string;
  lint: string;
  testFileGlobs: string[];
  vendorDirs: string[];
}

// Map a free-form stack.language string onto a profile key. Aliases keep common
// spellings (ts/js/golang/rs) pointing at the right ecosystem; anything we don't
// recognise falls to 'unknown' (skip-and-warn gates, never a wrong pnpm run).
export function normalizeLanguage(language: string): ProfileKey {
  const l = language.trim().toLowerCase();
  if (['typescript', 'ts', 'javascript', 'js', 'node', 'nodejs'].includes(l)) return 'node';
  if (['python', 'py'].includes(l)) return 'python';
  if (['go', 'golang'].includes(l)) return 'go';
  if (['rust', 'rs'].includes(l)) return 'rust';
  if (['java'].includes(l)) return 'java';
  return 'unknown';
}

// Non-node profiles are static. Node's command family depends on the package
// manager (pnpm/npm/yarn), so it is built per-config in nodeProfile().
const STATIC_PROFILES: Record<Exclude<ProfileKey, 'node'>, Profile> = {
  // Many Python repos have no build step, so build defaults to skip (OQ3).
  python: {
    build: '',
    test: 'pytest',
    lint: 'ruff check',
    testFileGlobs: ['test_*.py', '*_test.py'],
    vendorDirs: ['.venv', '__pycache__'],
  },
  go: {
    build: 'go build ./...',
    test: 'go test ./...',
    lint: 'go vet ./...',
    testFileGlobs: ['*_test.go'],
    vendorDirs: ['vendor'],
  },
  rust: {
    build: 'cargo build',
    test: 'cargo test',
    lint: 'cargo clippy',
    testFileGlobs: ['tests/**', '*_test.rs'],
    vendorDirs: ['target'],
  },
  java: {
    build: 'mvn -q compile',
    test: 'mvn -q test',
    lint: 'mvn -q checkstyle:check',
    testFileGlobs: ['*Test.java'],
    vendorDirs: ['target'],
  },
  // Unknown language: every command skips (visible warn), and we only refuse to
  // descend into .git during the discovery walk.
  unknown: {
    build: '',
    test: '',
    lint: '',
    testFileGlobs: [],
    vendorDirs: ['.git'],
  },
};

function nodeProfile(packageManager: string): Profile {
  const pm = packageManager.trim() || 'pnpm';
  return {
    build: `${pm} build`,
    test: `${pm} test`,
    lint: `${pm} lint`,
    testFileGlobs: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.js'],
    vendorDirs: ['node_modules', 'dist'],
  };
}

export function profileFor(kshetra: KshetraConfig): Profile {
  const key = normalizeLanguage(kshetra.stack.language);
  if (key === 'node') return nodeProfile(kshetra.stack.packageManager ?? 'pnpm');
  return STATIC_PROFILES[key];
}

// Resolve a command override: an explicit stack value (including "" for skip)
// wins; only when unset does the language default apply. Returned trimmed.
function resolveCommand(override: string | undefined, fallback: string): string {
  if (override !== undefined) return override.trim();
  return fallback;
}

// The authoritative compile/type-check gate (Viharapala). "" = skipped.
export function resolveBuildCommand(kshetra: KshetraConfig): string {
  return resolveCommand(kshetra.stack.buildCommand, profileFor(kshetra).build);
}

// The authoritative test gate (health). "" = skipped.
export function resolveTestCommand(kshetra: KshetraConfig): string {
  return resolveCommand(kshetra.stack.testRunner, profileFor(kshetra).test);
}

// The enforced lint gate (§3.3). "" = skipped; never synthesised for a repo
// that has no lint step.
export function resolveLintCommand(kshetra: KshetraConfig): string {
  return resolveCommand(kshetra.stack.lintCommand, profileFor(kshetra).lint);
}

// Test-file globs for Parikshaka's static discovery walk. Config override wins.
export function resolveTestGlobs(kshetra: KshetraConfig): string[] {
  return kshetra.stack.testFileGlobs ?? profileFor(kshetra).testFileGlobs;
}

// Directory names to skip when walking the repo. Config override wins.
export function resolveVendorDirs(kshetra: KshetraConfig): string[] {
  return kshetra.stack.vendorDirs ?? profileFor(kshetra).vendorDirs;
}

// Split a command string into argv (space-delimited, as the gates run today).
// Empty/whitespace command yields [] so callers can detect "skip".
export function splitCommand(command: string): string[] {
  const trimmed = command.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

// Translate a simple glob into an anchored RegExp. Supports `*` (any run of
// non-slash chars), a leading `**/` (zero or more directories — so
// `**/*.test.ts` also matches a root-level file), and a bare `**` (any run
// including slashes); other regex specials are escaped. Sentinels keep the `**`
// rewrites from being clobbered by the single-`*` step.
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '@@DIRS@@')
    .replace(/\*\*/g, '@@ANY@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DIRS@@/g, '(?:.*/)?')
    .replace(/@@ANY@@/g, '.*');
  return new RegExp('^' + escaped + '$');
}

// True when a repo-relative path matches any of the test-file globs. Globs
// without a `/` match against the basename; globs with a `/` (or a `**/` prefix)
// match against the full repo-relative path.
export function matchesTestGlob(relPath: string, globs: string[]): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  return globs.some(g => {
    const re = globToRegExp(g);
    return g.includes('/') ? re.test(relPath) : re.test(base);
  });
}