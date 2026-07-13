import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Pack } from '../kshetra/packs';
import { matchesTestGlob } from '../kshetra/toolchain';

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

// ── Pack detection (84m.3) ────────────────────────────────────────────────────
// Score each installed pack's data-only `detect` block against the repo and
// SUGGEST the best match at init. One point per matched hint: a root file
// glob, a package.json (dev)dependency, or a pyproject.toml dependency. A
// specific pack (e.g. nextjs-vitest: `next` dep + next.config.*) therefore
// outranks a generic one; ties are surfaced as ambiguous so init asks instead
// of guessing.

export interface PackScore {
  pack: Pack;
  score: number;
}

export interface PackSuggestion {
  // The single top scorer; undefined when nothing matched or the top is tied.
  best?: Pack;
  // Every pack with score > 0, sorted by score descending.
  candidates: PackScore[];
  ambiguous: boolean;
  warnings: string[];
}

export function scorePackDetect(repoPath: string, pack: Pack): number {
  const detect = pack.detect;
  if (!detect) return 0;
  let score = 0;

  if (detect.files?.length) {
    let entries: string[] = [];
    try {
      entries = readdirSync(repoPath);
    } catch {
      // repo dir missing/unreadable — no file hints can match
    }
    for (const glob of detect.files) {
      if (entries.some(e => matchesTestGlob(e, [glob]))) score++;
    }
  }

  if (detect.packageJson) {
    const pkg = readJson(join(repoPath, 'package.json'));
    if (pkg) {
      const deps = (pkg['dependencies'] ?? {}) as Record<string, unknown>;
      const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, unknown>;
      for (const dep of detect.packageJson.dependencies ?? []) {
        if (dep in deps) score++;
      }
      for (const dep of detect.packageJson.devDependencies ?? []) {
        if (dep in devDeps) score++;
      }
    }
  }

  if (detect.pyproject?.dependencies?.length) {
    let toml = '';
    try {
      toml = readFileSync(join(repoPath, 'pyproject.toml'), 'utf8');
    } catch {
      // no pyproject.toml
    }
    for (const dep of detect.pyproject.dependencies) {
      if (toml.includes(dep)) score++;
    }
  }

  return score;
}

export function suggestPack(repoPath: string, packs: Pack[]): PackSuggestion {
  const candidates = packs
    .map(pack => ({ pack, score: scorePackDetect(repoPath, pack) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const warnings: string[] = [];
  if (candidates.length === 0) {
    return { candidates, ambiguous: false, warnings };
  }
  const tied = candidates.filter(s => s.score === candidates[0].score);
  const best = tied.length === 1 ? tied[0].pack : undefined;

  // ARD §4.1 risk: the nextjs pack targets the App Router only in v1 — a
  // pages/-router repo gets the pack's gates but mismatched conventions.
  if (
    best?.name === 'nextjs-vitest' &&
    existsSync(join(repoPath, 'pages')) &&
    !existsSync(join(repoPath, 'app')) &&
    !existsSync(join(repoPath, 'src', 'app'))
  ) {
    warnings.push(
      `this repo looks like a Pages-Router Next.js app — the nextjs-vitest pack targets the App Router only; its conventions/rubric may not fit.`,
    );
  }

  return { best, candidates, ambiguous: tied.length > 1, warnings };
}