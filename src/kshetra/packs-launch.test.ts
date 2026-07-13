import { describe, it, expect } from 'vitest';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { listPacks, loadPack, defaultPacksDir, PACK_TEMPLATE_FILES, type Pack } from './packs.js';
import { suggestPack } from '../cli/detect-toolchain.js';
import {
  profileFor,
  resolveTestGlobs,
  resolveVendorDirs,
  matchesTestGlob,
} from './toolchain.js';
import { collectTestFiles } from '../sthapathi/parikshaka-dispatch.js';
import type { KshetraConfig } from './config.js';

// The four in-tree launch packs (ARD §4). These tests exercise the REAL pack
// directories: loader validation, detection against each pack's own reference
// fixture, and the 84m.1 uniformity check — each pack's stack values are
// either consistent with its language profile or deliberately divergent.

const PACKS_DIR = resolve(__dirname, '..', '..', 'packs');
const LAUNCH = ['go-service', 'nextjs-vitest', 'node-api', 'python-fastapi'];

function kshetraFor(pack: Pack): KshetraConfig {
  // toolchain resolvers only read stack.* — a minimal cast keeps this a unit test.
  return { stack: pack.stack } as KshetraConfig;
}

describe('launch packs — loader', () => {
  it('defaultPacksDir points at the in-tree packs/', () => {
    expect(defaultPacksDir()).toBe(PACKS_DIR);
  });

  it('ships exactly the four launch packs, all valid', () => {
    const packs = listPacks(PACKS_DIR);
    expect(packs.map(p => p.name).sort()).toEqual(LAUNCH);
    for (const p of packs) expect(p.version).toBe(1);
  });

  it('every pack carries the three conventions templates and a reference fixture with backlog.sh', () => {
    for (const name of LAUNCH) {
      const pack = loadPack(join(PACKS_DIR, name));
      for (const f of PACK_TEMPLATE_FILES) {
        expect(existsSync(join(pack.dir, f)), `${name}/${f}`).toBe(true);
      }
      expect(existsSync(join(pack.dir, 'reference', 'backlog.sh')), `${name}/reference/backlog.sh`).toBe(true);
    }
  });
});

describe('launch packs — detection on the reference fixtures', () => {
  const packs = listPacks(PACKS_DIR);

  it.each(LAUNCH)('%s reference fixture suggests its own pack, unambiguously', name => {
    const suggestion = suggestPack(join(PACKS_DIR, name, 'reference'), packs);
    expect(suggestion.best?.name).toBe(name);
    expect(suggestion.ambiguous).toBe(false);
  });
});

describe('launch packs — profile uniformity (84m.1 decision)', () => {
  const byName = Object.fromEntries(listPacks(PACKS_DIR).map(p => [p.name, p]));

  it('nextjs-vitest and node-api are consistent with the node/pnpm profile', () => {
    for (const name of ['nextjs-vitest', 'node-api']) {
      const pack = byName[name];
      const profile = profileFor(kshetraFor(pack));
      expect(pack.stack.buildCommand).toBe(profile.build);   // pnpm build
      expect(pack.stack.testRunner).toBe(profile.test);      // pnpm test
      expect(pack.stack.lintCommand).toBe(profile.lint);     // pnpm lint
    }
  });

  it('python-fastapi deliberately diverges: uv-first commands, no build/coverage gate', () => {
    const pack = byName['python-fastapi'];
    const profile = profileFor(kshetraFor(pack));
    expect(pack.stack.buildCommand).toBe(profile.build);     // '' — consistent (OQ3)
    expect(pack.stack.testRunner).toBe(`uv run ${profile.test}`);   // uv wraps pytest
    expect(pack.stack.lintCommand).toBe(`uv run ${profile.lint}`);  // uv wraps ruff check
    expect(pack.stack.coverageCommand).toBe('');             // explicit visible skip
  });

  it('go-service deliberately diverges on exactly one axis: -race in the test gate', () => {
    const pack = byName['go-service'];
    const profile = profileFor(kshetraFor(pack));
    expect(pack.stack.buildCommand).toBe(profile.build);     // go build ./...
    expect(pack.stack.lintCommand).toBe(profile.lint);       // go vet ./...
    expect(pack.stack.testRunner).toBe('go test -race ./...');
    expect(profile.test).toBe('go test ./...');              // the divergence is race-only
  });
});

describe('launch packs — fixture test files match the pack globs (Parikshaka discovery pre-check)', () => {
  const expected: Record<string, string[]> = {
    'nextjs-vitest': ['src/domain/notes.test.ts'],
    'node-api': ['src/app.test.ts'],
    'python-fastapi': ['tests/test_items.py'],
    'go-service': ['internal/httpapi/handler_test.go', 'internal/notes/notes_test.go'],
  };

  it.each(LAUNCH)('%s fixture tests are discoverable with the resolved globs', async name => {
    const pack = loadPack(join(PACKS_DIR, name));
    const k = kshetraFor(pack);
    const found = await collectTestFiles(
      join(pack.dir, 'reference'),
      resolveTestGlobs(k),
      resolveVendorDirs(k),
    );
    expect(found.sort()).toEqual(expected[name]);
    for (const f of expected[name]) {
      expect(matchesTestGlob(f, resolveTestGlobs(k))).toBe(true);
    }
  });
});
