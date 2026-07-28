import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { KshetraConfig } from './config.js';
import { generateRepoMap, loadRepoMap, regenerateRepoMapAsync } from './repo-map.js';

// Minimal Kshetra carrying only the fields repo-map reads (name, repo.path, stack).
function ksh(root: string, language = 'typescript'): KshetraConfig {
  return { name: 'Testproj', repo: { path: root }, stack: { language } } as unknown as KshetraConfig;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-map-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('generateRepoMap (TypeScript)', () => {
  beforeEach(() => {
    write(
      'src/auth.ts',
      `// Token refresh and 401 recovery for the API client.\n` +
        `export function refreshToken() {}\n` +
        `export class AuthClient {}\n` +
        `export interface Session {}\n` +
        `const internal = 1;\n`,
    );
    write(
      'src/util/format.ts',
      `/** Formatting helpers for dates and currency. */\n` +
        `export const formatDate = () => {};\n` +
        `export type Money = number;\n`,
    );
    // Excluded: test file, vendored dir.
    write('src/auth.test.ts', `export function shouldBeExcluded() {}\n`);
    write('node_modules/dep/index.ts', `export function vendored() {}\n`);
  });

  it('lists source files with their exported symbols', async () => {
    const map = await generateRepoMap(ksh(root));
    expect(map).toContain('`auth.ts`');
    expect(map).toContain('refreshToken');
    expect(map).toContain('AuthClient');
    expect(map).toContain('Session');
    expect(map).toContain('formatDate');
    expect(map).toContain('Money');
  });

  it('extracts the leading comment as the module role', async () => {
    const map = await generateRepoMap(ksh(root));
    expect(map).toContain('Token refresh and 401 recovery for the API client.');
    expect(map).toContain('Formatting helpers for dates and currency.');
  });

  it('excludes test files and vendored directories', async () => {
    const map = await generateRepoMap(ksh(root));
    expect(map).not.toContain('shouldBeExcluded');
    expect(map).not.toContain('vendored');
    expect(map).not.toContain('node_modules');
  });

  it('omits non-exported/internal symbols', async () => {
    const map = await generateRepoMap(ksh(root));
    expect(map).not.toContain('internal');
  });

  it('writes the map to .shreni/repo-map.md', async () => {
    await generateRepoMap(ksh(root));
    const dest = join(root, '.shreni', 'repo-map.md');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toContain('# Repo Map — Testproj');
  });

  it('is deterministic — two runs produce identical output', async () => {
    const a = await generateRepoMap(ksh(root));
    const b = await generateRepoMap(ksh(root));
    expect(a).toBe(b);
  });
});

describe('generateRepoMap (other languages)', () => {
  it('extracts exported (capitalized) Go symbols and skips unexported ones', async () => {
    write('main.go', `// Package entrypoint.\npackage main\nfunc Run() {}\ntype Config struct{}\nfunc helper() {}\n`);
    const map = await generateRepoMap(ksh(root, 'go'));
    expect(map).toContain('Run');
    expect(map).toContain('Config');
    expect(map).not.toContain('helper');
  });

  it('extracts top-level Python defs/classes and skips underscore-private ones', async () => {
    write('app.py', `"""Application service layer."""\ndef handle():\n    pass\nclass Service:\n    pass\ndef _private():\n    pass\n`);
    const map = await generateRepoMap(ksh(root, 'python'));
    expect(map).toContain('handle');
    expect(map).toContain('Service');
    expect(map).toContain('Application service layer.');
    expect(map).not.toContain('_private');
  });
});

describe('bounds', () => {
  it('truncates and notes when the byte budget is exceeded', async () => {
    // Many files, each with a long role, to push past MAX_BYTES (24 KB).
    for (let i = 0; i < 500; i++) {
      const n = String(i).padStart(4, '0');
      write(`src/mod${n}.ts`, `// ${'x'.repeat(90)} module ${n}\nexport function fn${n}() {}\n`);
    }
    const map = await generateRepoMap(ksh(root));
    expect(Buffer.byteLength(map, 'utf8')).toBeLessThanOrEqual(24_500);
    expect(map).toContain('Map truncated at');
  });
});

describe('loadRepoMap', () => {
  it('returns the cached file when present', async () => {
    mkdirSync(join(root, '.shreni'), { recursive: true });
    writeFileSync(join(root, '.shreni', 'repo-map.md'), 'CACHED MAP', 'utf8');
    expect(await loadRepoMap(ksh(root))).toBe('CACHED MAP');
  });

  it('generates the map when the cache is absent', async () => {
    write('src/a.ts', `export function a() {}\n`);
    const map = await loadRepoMap(ksh(root));
    expect(map).toContain('`a.ts`');
    // ...and caches it as a side effect.
    expect(existsSync(join(root, '.shreni', 'repo-map.md'))).toBe(true);
  });

  it('returns empty string for a repo with no source files', async () => {
    expect(await loadRepoMap(ksh(root))).toBe('');
  });

  it('returns empty string when the repo path does not exist', async () => {
    expect(await loadRepoMap(ksh(join(root, 'nope')))).toBe('');
  });
});

describe('regenerateRepoMapAsync', () => {
  it('refreshes the cache without throwing', async () => {
    write('src/a.ts', `export function a() {}\n`);
    regenerateRepoMapAsync(ksh(root));
    // Poll for the fire-and-forget write to land (several awaited fs ops).
    const dest = join(root, '.shreni', 'repo-map.md');
    for (let i = 0; i < 200 && !existsSync(dest); i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    expect(existsSync(dest)).toBe(true);
  });
});
