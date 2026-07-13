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
// ── Pack detection (84m.3) ────────────────────────────────────────────────────

import { mkdirSync } from 'fs';
import { suggestPack, scorePackDetect } from './detect-toolchain.js';
import type { Pack } from '../kshetra/packs.js';

function fakePack(name: string, detect: Pack['detect']): Pack {
  return { name, version: 1, dir: `/packs/${name}`, stack: { language: 'x' }, detect };
}

// The four launch packs' detect blocks (ARD §4 table).
const LAUNCH_PACKS: Pack[] = [
  fakePack('nextjs-vitest', {
    files: ['next.config.*'],
    packageJson: { dependencies: ['next'], devDependencies: ['vitest'] },
  }),
  fakePack('node-api', {
    packageJson: { dependencies: ['fastify', 'express'] },
  }),
  fakePack('python-fastapi', {
    pyproject: { dependencies: ['fastapi'] },
  }),
  fakePack('go-service', {
    files: ['go.mod'],
  }),
];

describe('suggestPack — each launch-pack fixture suggests its own pack', () => {
  it('next dep + next.config.* + vitest → nextjs-vitest', () => {
    write('package.json', JSON.stringify({ dependencies: { next: '^15' }, devDependencies: { vitest: '^4' } }));
    write('next.config.mjs');
    const s = suggestPack(dir, LAUNCH_PACKS);
    expect(s.best?.name).toBe('nextjs-vitest');
    expect(s.ambiguous).toBe(false);
  });

  it('fastify dep without next → node-api', () => {
    write('package.json', JSON.stringify({ dependencies: { fastify: '^5' } }));
    expect(suggestPack(dir, LAUNCH_PACKS).best?.name).toBe('node-api');
  });

  it('fastapi in pyproject.toml → python-fastapi', () => {
    write('pyproject.toml', '[project]\ndependencies = ["fastapi", "uvicorn"]\n');
    expect(suggestPack(dir, LAUNCH_PACKS).best?.name).toBe('python-fastapi');
  });

  it('go.mod → go-service', () => {
    write('go.mod', 'module example.com/svc\n');
    expect(suggestPack(dir, LAUNCH_PACKS).best?.name).toBe('go-service');
  });
});

describe('suggestPack — ambiguity and misses', () => {
  it('a tie between packs is ambiguous — no best, both listed', () => {
    write('package.json', JSON.stringify({ dependencies: { fastify: '^5' } }));
    write('go.mod', 'module example.com/svc\n');
    const s = suggestPack(dir, LAUNCH_PACKS);
    expect(s.best).toBeUndefined();
    expect(s.ambiguous).toBe(true);
    expect(s.candidates.map(c => c.pack.name).sort()).toEqual(['go-service', 'node-api']);
  });

  it('an empty repo matches nothing', () => {
    const s = suggestPack(dir, LAUNCH_PACKS);
    expect(s.best).toBeUndefined();
    expect(s.ambiguous).toBe(false);
    expect(s.candidates).toEqual([]);
  });

  it('a more specific pack outranks a generic one (next repo never suggests node-api)', () => {
    write('package.json', JSON.stringify({ dependencies: { next: '^15', express: '^4' }, devDependencies: { vitest: '^4' } }));
    write('next.config.ts');
    const s = suggestPack(dir, LAUNCH_PACKS);
    expect(s.best?.name).toBe('nextjs-vitest');
  });
});

describe('suggestPack — nextjs App Router check (ARD §4.1)', () => {
  const nextRepo = () => {
    write('package.json', JSON.stringify({ dependencies: { next: '^15' }, devDependencies: { vitest: '^4' } }));
    write('next.config.mjs');
  };

  it('warns on a pages/-router repo', () => {
    nextRepo();
    mkdirSync(join(dir, 'pages'));
    const s = suggestPack(dir, LAUNCH_PACKS);
    expect(s.best?.name).toBe('nextjs-vitest');
    expect(s.warnings.join(' ')).toContain('App Router');
  });

  it('does not warn on an App Router repo', () => {
    nextRepo();
    mkdirSync(join(dir, 'app'));
    expect(suggestPack(dir, LAUNCH_PACKS).warnings).toEqual([]);
  });

  it('does not warn on a src/app App Router repo with a legacy pages/ dir', () => {
    nextRepo();
    mkdirSync(join(dir, 'pages'));
    mkdirSync(join(dir, 'src', 'app'), { recursive: true });
    expect(suggestPack(dir, LAUNCH_PACKS).warnings).toEqual([]);
  });
});

describe('scorePackDetect', () => {
  it('scores one point per matched hint', () => {
    write('package.json', JSON.stringify({ dependencies: { next: '^15' }, devDependencies: { vitest: '^4' } }));
    write('next.config.mjs');
    expect(scorePackDetect(dir, LAUNCH_PACKS[0])).toBe(3);
  });

  it('scores 0 for a pack without a detect block', () => {
    write('go.mod');
    expect(scorePackDetect(dir, fakePack('no-detect', undefined))).toBe(0);
  });

  it('scores 0 against a missing repo directory', () => {
    expect(scorePackDetect(join(dir, 'nope'), LAUNCH_PACKS[3])).toBe(0);
  });
});
