import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import ts from 'typescript';

// The engine's import boundary (engine spec, "Where the code lives"): nothing
// under src/taskgraph/ may import from outside the directory, other than Node
// built-ins and the adopted libraries. Shreni has no linter, so this is the rule.

const ROOT = __dirname;

// The spec's "Adopt" table: what shipped engine code may import. These are
// runtime dependencies in package.json.
const RUNTIME_PACKAGES = new Set(['postgres', 'kysely', 'graphology', 'graphology-dag', 'graphology-types', 'zod']);

// Dev-only packages (devDependencies, absent from an npm install of shreni):
// allowed only in test files and under test/, never in shipped engine code.
const TEST_PACKAGES = new Set(['@electric-sql/pglite', '@testcontainers/postgresql', 'fast-check', 'vitest', 'typescript', 'esbuild']);

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface Violation {
  file: string;
  specifier: string;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The path of `target` relative to `root`, or null when it lies outside. */
function inside(root: string, target: string): string | null {
  const rel = relative(root, target);
  return rel.split(sep)[0] === '..' || isAbsolute(rel) ? null : rel;
}

function isTestPath(rel: string): boolean {
  return rel.split(sep)[0] === 'test' || /\.test\.[cm]?[jt]sx?$/.test(rel);
}

function isAllowed(root: string, file: string, specifier: string): boolean {
  const fromTest = isTestPath(inside(root, file) ?? '');
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const rel = inside(root, resolve(dirname(file), specifier));
    // Shipped code must not reach into test/: tsconfig excludes it from dist.
    return rel !== null && (fromTest || !isTestPath(rel));
  }
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return true;
  const pkg = packageName(specifier);
  return RUNTIME_PACKAGES.has(pkg) || (fromTest && TEST_PACKAGES.has(pkg));
}

/**
 * Every import, re-export, dynamic import, require and `/// <reference path>`
 * that leaves `root`. Computed specifiers (`import(p)`, `createRequire`) can't
 * be resolved statically and are not seen.
 */
function findBoundaryViolations(root: string, files: { file: string; source: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { file, source } of files) {
    // preProcessFile parses real import syntax, so imports quoted in strings or
    // comments (like this test's own fixtures) are not counted.
    const { importedFiles, referencedFiles } = ts.preProcessFile(source, true, true);
    for (const { fileName } of [...importedFiles, ...referencedFiles]) {
      if (!isAllowed(root, file, fileName)) violations.push({ file, specifier: fileName });
    }
  }
  return violations;
}

function scanBoundary(root: string): Violation[] {
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(f => SOURCE_FILE.test(f) && !f.endsWith('.d.ts'))
    .map(f => join(root, f))
    .map(file => ({ file, source: readFileSync(file, 'utf8') }));
  return findBoundaryViolations(root, files);
}

describe('taskgraph import boundary', () => {
  it('no file under src/taskgraph/ imports from outside it', () => {
    expect(scanBoundary(ROOT)).toEqual([]);
  });

  it('names an import that reaches into src/sthapathi/', () => {
    const file = join(ROOT, 'claim.ts');
    const violations = findBoundaryViolations(ROOT, [
      { file, source: "import { Sthapathi } from '../sthapathi/index';\n" },
    ]);
    expect(violations).toEqual([{ file, specifier: '../sthapathi/index' }]);
  });

  it('catches every import form', () => {
    const file = join(ROOT, 'a.ts');
    const source = [
      "import x from 'fastify';",
      "import type { Y } from '../kshetra/config';",
      "export { z } from '../cli/index';",
      "import '../telemetry/setup';",
      "const m = await import('../agents/x');",
      "const r = require('js-yaml');",
      'import {',
      '  multi,',
      "} from '../sthapathi/loop';",
    ].join('\n');
    const specifiers = findBoundaryViolations(ROOT, [{ file, source }]).map(v => v.specifier);
    expect(specifiers).toEqual([
      'fastify',
      '../kshetra/config',
      '../cli/index',
      '../telemetry/setup',
      '../agents/x',
      'js-yaml',
      '../sthapathi/loop',
    ]);
  });

  it('allows relative imports inside the directory, Node built-ins and the adopted libraries', () => {
    const file = join(ROOT, 'store', 'tasks.test.ts');
    const source = [
      "import { a } from './ids';",
      "import { b } from '../events';",
      "import { readFileSync } from 'fs';",
      "import { randomUUID } from 'node:crypto';",
      "import postgres from 'postgres';",
      "import { Kysely, sql } from 'kysely';",
      "import Graph from 'graphology';",
      "import { hasCycle } from 'graphology-dag';",
      "import { z } from 'zod';",
      "import { PGlite } from '@electric-sql/pglite';",
      "import { PostgreSqlContainer } from '@testcontainers/postgresql';",
      "import fc from 'fast-check';",
      "import { describe } from 'vitest';",
    ].join('\n');
    expect(findBoundaryViolations(ROOT, [{ file, source }])).toEqual([]);
  });

  it('refuses a relative import that climbs out and back into a lookalike directory', () => {
    const file = join(ROOT, 'a.ts');
    const source = "import x from '../taskgraph-old/a';";
    expect(findBoundaryViolations(ROOT, [{ file, source }])).toEqual([
      { file, specifier: '../taskgraph-old/a' },
    ]);
  });

  it('allows subpath imports of adopted libraries', () => {
    const file = join(ROOT, 'a.test.ts');
    const source = "import { PGlite } from '@electric-sql/pglite/vector';\nimport x from 'kysely/helpers/postgres';";
    expect(findBoundaryViolations(ROOT, [{ file, source }])).toEqual([]);
  });

  it('refuses dev-only packages and test/ helpers in shipped engine code', () => {
    const file = join(ROOT, 'store', 'tasks.ts');
    const source = [
      "import { PGlite } from '@electric-sql/pglite';",
      "import fc from 'fast-check';",
      "import ts from 'typescript';",
      "import { createTestDb } from '../test/pglite';",
      "import { Kysely } from 'kysely';",
    ].join('\n');
    expect(findBoundaryViolations(ROOT, [{ file, source }]).map(v => v.specifier)).toEqual([
      '@electric-sql/pglite',
      'fast-check',
      'typescript',
      '../test/pglite',
    ]);
  });

  it('lets test/ helpers use dev-only packages and each other', () => {
    const file = join(ROOT, 'test', 'pglite.ts');
    const source = "import { PGlite } from '@electric-sql/pglite';\nimport { x } from './other';\nimport { y } from '../ids';";
    expect(findBoundaryViolations(ROOT, [{ file, source }])).toEqual([]);
  });

  it('catches a triple-slash reference path', () => {
    const file = join(ROOT, 'a.ts');
    const source = '/// <reference path="../sthapathi/types.ts" />\nexport {};';
    expect(findBoundaryViolations(ROOT, [{ file, source }])).toEqual([
      { file, specifier: '../sthapathi/types.ts' },
    ]);
  });

  it('scans .tsx and .jsx files', () => {
    expect(SOURCE_FILE.test('debug/view.tsx')).toBe(true);
    expect(SOURCE_FILE.test('debug/view.jsx')).toBe(true);
  });
});
