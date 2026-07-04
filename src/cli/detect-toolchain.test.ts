import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectToolchain } from './detect-toolchain.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shreni-detect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content = ''): void {
  writeFileSync(join(dir, name), content, 'utf8');
}

describe('detectToolchain — node', () => {
  it('detects pnpm from the lockfile and reads real script names', () => {
    write('package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'jest', lint: 'eslint .' } }));
    write('pnpm-lock.yaml');
    write('tsconfig.json');
    const s = detectToolchain(dir);
    expect(s).toEqual({
      language: 'typescript',
      packageManager: 'pnpm',
      buildCommand: 'pnpm build',
      testRunner: 'pnpm test',
      lintCommand: 'pnpm lint',
      unknown: false,
    });
  });

  it('points testRunner at the repo script (pnpm test), not the underlying runner', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'jest --ci' } }));
    write('tsconfig.json');
    const s = detectToolchain(dir);
    expect(s.testRunner).toBe('pnpm test');
    expect(s.testRunner).not.toContain('jest');
  });

  it('detects yarn from yarn.lock and javascript without tsconfig/typescript', () => {
    write('package.json', JSON.stringify({ scripts: { build: 'webpack' } }));
    write('yarn.lock');
    const s = detectToolchain(dir);
    expect(s.packageManager).toBe('yarn');
    expect(s.language).toBe('javascript');
    expect(s.buildCommand).toBe('yarn build');
  });

  it('detects npm from package-lock.json', () => {
    write('package.json', JSON.stringify({ scripts: {} }));
    write('package-lock.json');
    expect(detectToolchain(dir).packageManager).toBe('npm');
  });

  it('honours the packageManager field over the lockfile', () => {
    write('package.json', JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: {} }));
    write('yarn.lock');
    expect(detectToolchain(dir).packageManager).toBe('pnpm');
  });

  it('marks missing scripts as explicitly skipped ("")', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'vitest' } })); // no build/lint
    const s = detectToolchain(dir);
    expect(s.testRunner).toBe('pnpm test');
    expect(s.buildCommand).toBe('');
    expect(s.lintCommand).toBe('');
  });

  it('treats typescript in devDependencies as a typescript project', () => {
    write('package.json', JSON.stringify({ devDependencies: { typescript: '^5' }, scripts: {} }));
    expect(detectToolchain(dir).language).toBe('typescript');
  });
});

describe('detectToolchain — other ecosystems', () => {
  it('detects python from pyproject.toml', () => {
    write('pyproject.toml');
    expect(detectToolchain(dir)).toEqual({ language: 'python', unknown: false });
  });
  it('detects python from requirements.txt', () => {
    write('requirements.txt');
    expect(detectToolchain(dir).language).toBe('python');
  });
  it('detects go from go.mod', () => {
    write('go.mod');
    expect(detectToolchain(dir).language).toBe('go');
  });
  it('detects rust from Cargo.toml', () => {
    write('Cargo.toml');
    expect(detectToolchain(dir).language).toBe('rust');
  });
  it('detects java from pom.xml', () => {
    write('pom.xml');
    expect(detectToolchain(dir).language).toBe('java');
  });
});

describe('detectToolchain — unknown', () => {
  it('flags unknown and writes empty (skipped) commands when no marker is found', () => {
    const s = detectToolchain(dir);
    expect(s.unknown).toBe(true);
    expect(s.language).toBe('unknown');
    expect(s.buildCommand).toBe('');
    expect(s.testRunner).toBe('');
    expect(s.lintCommand).toBe('');
  });

  it('falls back to unknown when package.json is unparseable', () => {
    write('package.json', '{ not json');
    expect(detectToolchain(dir).unknown).toBe(true);
  });
});