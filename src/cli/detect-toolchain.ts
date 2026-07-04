import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Ecosystem detection for `shreni init` (the project-init design §3.6). Inspect the
// repo's marker files and produce a toolchain profile the Kshetra config can be
// populated from. The heavy lifting of per-language defaults lives in
// src/kshetra/toolchain.ts; detection only picks the language / package manager
// and, for node, reads the REAL script names from package.json so we point at
// the repo's own scripts (`pnpm test` → its `test` script → its runner) instead
// of guessing the underlying tool.

export interface DetectedStack {
  language: string;
  packageManager?: string;
  buildCommand?: string;
  testRunner?: string;
  lintCommand?: string;
  // True when no known ecosystem marker was found — init writes a valid config
  // with empty commands + a TODO marker and prints which fields to fill.
  unknown: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// pnpm/npm/yarn from package.json's `packageManager` field, else the lockfile,
// else pnpm (the Shreni default).
function detectPackageManager(repoPath: string, pkg: Record<string, unknown>): string {
  const declared = typeof pkg['packageManager'] === 'string' ? (pkg['packageManager'] as string) : '';
  const name = declared.split('@')[0].trim();
  if (name === 'pnpm' || name === 'npm' || name === 'yarn') return name;
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoPath, 'package-lock.json'))) return 'npm';
  return 'pnpm';
}

function hasDep(pkg: Record<string, unknown>, dep: string): boolean {
  const deps = (pkg['dependencies'] ?? {}) as Record<string, unknown>;
  const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, unknown>;
  return dep in deps || dep in devDeps;
}

function detectNode(repoPath: string, pkg: Record<string, unknown>): DetectedStack {
  const packageManager = detectPackageManager(repoPath, pkg);
  const hasTs = existsSync(join(repoPath, 'tsconfig.json')) || hasDep(pkg, 'typescript');
  const language = hasTs ? 'typescript' : 'javascript';
  const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;

  // Point at the repo's own script when it exists (so a `test` script running
  // jest becomes `pnpm test`, not a guessed `vitest`); an empty string means the
  // repo has no such script, so that gate is explicitly skipped.
  const cmd = (name: string): string => (typeof scripts[name] === 'string' ? `${packageManager} ${name}` : '');

  return {
    language,
    packageManager,
    buildCommand: cmd('build'),
    testRunner: cmd('test'),
    lintCommand: cmd('lint'),
    unknown: false,
  };
}

// Detect the toolchain from marker files in repoPath. Non-node ecosystems return
// just the language; their per-language command defaults come from the toolchain
// resolver, so the config stays minimal and drift-free.
export function detectToolchain(repoPath: string): DetectedStack {
  if (existsSync(join(repoPath, 'package.json'))) {
    const pkg = readJson(join(repoPath, 'package.json'));
    if (pkg) return detectNode(repoPath, pkg);
  }
  if (existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'requirements.txt'))) {
    return { language: 'python', unknown: false };
  }
  if (existsSync(join(repoPath, 'go.mod'))) {
    return { language: 'go', unknown: false };
  }
  if (existsSync(join(repoPath, 'Cargo.toml'))) {
    return { language: 'rust', unknown: false };
  }
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) {
    return { language: 'java', unknown: false };
  }
  // Unknown ecosystem: write empty commands (explicit skip) and let init print
  // guidance on which fields to fill.
  return { language: 'unknown', buildCommand: '', testRunner: '', lintCommand: '', unknown: true };
}