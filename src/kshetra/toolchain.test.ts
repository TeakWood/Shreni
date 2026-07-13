import { describe, it, expect } from 'vitest';
import type { KshetraConfig } from './config.js';
import {
  normalizeLanguage,
  resolveBuildCommand,
  resolveTestCommand,
  resolveLintCommand,
  resolveCoverageCommand,
  resolveTestGlobs,
  resolveVendorDirs,
  splitCommand,
  matchesTestGlob,
} from './toolchain.js';

// Minimal Kshetra with only the stack fields the resolvers read.
function ksh(stack: Partial<KshetraConfig['stack']> & { language: string }): KshetraConfig {
  return { stack } as unknown as KshetraConfig;
}

describe('normalizeLanguage', () => {
  it('maps ts/js aliases to node', () => {
    for (const l of ['typescript', 'TS', 'javascript', 'js', 'node', 'nodejs']) {
      expect(normalizeLanguage(l)).toBe('node');
    }
  });
  it('maps python/go/rust/java aliases', () => {
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('golang')).toBe('go');
    expect(normalizeLanguage('rs')).toBe('rust');
    expect(normalizeLanguage('java')).toBe('java');
  });
  it('falls back to unknown for anything unrecognised', () => {
    expect(normalizeLanguage('cobol')).toBe('unknown');
  });
});

describe('default profiles', () => {
  it('typescript → pnpm build/test/lint + node globs/vendors', () => {
    const k = ksh({ language: 'typescript' });
    expect(resolveBuildCommand(k)).toBe('pnpm build');
    expect(resolveTestCommand(k)).toBe('pnpm test');
    expect(resolveLintCommand(k)).toBe('pnpm lint');
    expect(resolveCoverageCommand(k)).toBe('pnpm test:coverage');
    expect(resolveTestGlobs(k)).toEqual(['**/*.test.ts', '**/*.spec.ts', '**/*.test.js']);
    expect(resolveVendorDirs(k)).toEqual(['node_modules', 'dist']);
  });
  it('python → skip build, pytest, ruff', () => {
    const k = ksh({ language: 'python' });
    expect(resolveBuildCommand(k)).toBe('');
    expect(resolveTestCommand(k)).toBe('pytest');
    expect(resolveLintCommand(k)).toBe('ruff check');
    expect(resolveCoverageCommand(k)).toBe('pytest --cov');
    expect(resolveTestGlobs(k)).toEqual(['test_*.py', '*_test.py']);
    expect(resolveVendorDirs(k)).toEqual(['.venv', '__pycache__']);
  });
  it('go → go build/test/vet', () => {
    const k = ksh({ language: 'go' });
    expect(resolveBuildCommand(k)).toBe('go build ./...');
    expect(resolveTestCommand(k)).toBe('go test ./...');
    expect(resolveLintCommand(k)).toBe('go vet ./...');
    expect(resolveCoverageCommand(k)).toBe('go test -cover ./...');
    expect(resolveTestGlobs(k)).toEqual(['*_test.go']);
    expect(resolveVendorDirs(k)).toEqual(['vendor']);
  });
  it('rust → cargo build/test/clippy', () => {
    const k = ksh({ language: 'rust' });
    expect(resolveBuildCommand(k)).toBe('cargo build');
    expect(resolveTestCommand(k)).toBe('cargo test');
    expect(resolveLintCommand(k)).toBe('cargo clippy');
    expect(resolveCoverageCommand(k)).toBe('');
    expect(resolveVendorDirs(k)).toEqual(['target']);
  });
  it('java → mvn compile/test/checkstyle', () => {
    const k = ksh({ language: 'java' });
    expect(resolveBuildCommand(k)).toBe('mvn -q compile');
    expect(resolveTestCommand(k)).toBe('mvn -q test');
    expect(resolveLintCommand(k)).toBe('mvn -q checkstyle:check');
    expect(resolveCoverageCommand(k)).toBe('');
  });
  it('unknown → every command skipped, walk only skips .git', () => {
    const k = ksh({ language: 'brainfuck' });
    expect(resolveBuildCommand(k)).toBe('');
    expect(resolveTestCommand(k)).toBe('');
    expect(resolveLintCommand(k)).toBe('');
    expect(resolveCoverageCommand(k)).toBe('');
    expect(resolveTestGlobs(k)).toEqual([]);
    expect(resolveVendorDirs(k)).toEqual(['.git']);
  });
});

describe('packageManager switches the node command family', () => {
  it('npm/yarn override pnpm', () => {
    expect(resolveBuildCommand(ksh({ language: 'ts', packageManager: 'npm' }))).toBe('npm build');
    expect(resolveTestCommand(ksh({ language: 'ts', packageManager: 'yarn' }))).toBe('yarn test');
    expect(resolveLintCommand(ksh({ language: 'ts', packageManager: 'npm' }))).toBe('npm lint');
    expect(resolveCoverageCommand(ksh({ language: 'ts', packageManager: 'npm' }))).toBe('npm test:coverage');
  });
});

describe('config overrides win over defaults', () => {
  it('explicit commands override the language default', () => {
    const k = ksh({
      language: 'python',
      buildCommand: 'make build',
      testRunner: 'tox',
      lintCommand: 'flake8',
      coverageCommand: 'pytest --cov=src --cov-fail-under=80',
    });
    expect(resolveBuildCommand(k)).toBe('make build');
    expect(resolveTestCommand(k)).toBe('tox');
    expect(resolveLintCommand(k)).toBe('flake8');
    expect(resolveCoverageCommand(k)).toBe('pytest --cov=src --cov-fail-under=80');
  });
  it('explicit empty string means the gate is skipped (not the default)', () => {
    const k = ksh({ language: 'go', buildCommand: '', testRunner: '', coverageCommand: '' });
    expect(resolveBuildCommand(k)).toBe('');
    expect(resolveTestCommand(k)).toBe('');
    expect(resolveCoverageCommand(k)).toBe('');
  });
  it('explicit globs/vendorDirs override the profile', () => {
    const k = ksh({ language: 'go', testFileGlobs: ['**/*.spec.go'], vendorDirs: ['third_party'] });
    expect(resolveTestGlobs(k)).toEqual(['**/*.spec.go']);
    expect(resolveVendorDirs(k)).toEqual(['third_party']);
  });
});

describe('splitCommand', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('go test ./...')).toEqual(['go', 'test', './...']);
  });
  it('returns [] for an empty/whitespace command (skip signal)', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   ')).toEqual([]);
  });
});

describe('matchesTestGlob', () => {
  it('matches node suffix globs against the basename', () => {
    expect(matchesTestGlob('src/auth.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(matchesTestGlob('src/auth.ts', ['**/*.test.ts'])).toBe(false);
  });
  it('matches python/go prefix+suffix globs', () => {
    expect(matchesTestGlob('pkg/test_auth.py', ['test_*.py', '*_test.py'])).toBe(true);
    expect(matchesTestGlob('pkg/auth_test.go', ['*_test.go'])).toBe(true);
    expect(matchesTestGlob('pkg/auth.go', ['*_test.go'])).toBe(false);
  });
  it('matches path globs containing a slash against the relative path', () => {
    expect(matchesTestGlob('tests/integration/foo.rs', ['tests/**'])).toBe(true);
    expect(matchesTestGlob('src/foo.rs', ['tests/**'])).toBe(false);
  });
  it('returns false when no glob matches or the list is empty', () => {
    expect(matchesTestGlob('foo.py', [])).toBe(false);
  });
});