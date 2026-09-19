import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getBuildIdentity } from './build-info.js';

// The package version, read the same way the reader's fallback does.
const pkgVersion = (JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string }).version;

// getBuildIdentity reads dist/build-info.json relative to the compiled module; run
// from src/ under vitest that path resolves to src/build-info.json, which does not
// exist in the repo — i.e. the dev/unstamped case. Tests that exercise the present-
// file path write a fixture there and always remove it in a finally.
const srcBuildInfo = resolve(__dirname, '..', 'build-info.json');

describe('getBuildIdentity (epic yrk / Study B2, yrk.2)', () => {
  it('returns the unknown fallback when no build info is stamped, without throwing', () => {
    expect(existsSync(srcBuildInfo)).toBe(false); // guard: no stray fixture leaked in
    expect(getBuildIdentity()).toEqual({
      version: pkgVersion, commit: 'unknown', dirty: null, builtAt: null,
    });
  });

  it('reads a stamped build-info.json and returns its fields', () => {
    const stamped = { version: '9.9.9', commit: 'abc123', dirty: false, builtAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(srcBuildInfo, JSON.stringify(stamped), 'utf8');
    try {
      expect(getBuildIdentity()).toEqual(stamped);
    } finally {
      rmSync(srcBuildInfo, { force: true });
    }
  });

  it('preserves nulls from a build cut outside a git checkout', () => {
    writeFileSync(
      srcBuildInfo,
      JSON.stringify({ version: '1.2.3', commit: null, dirty: null, builtAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );
    try {
      const id = getBuildIdentity();
      expect(id.version).toBe('1.2.3');
      expect(id.commit).toBeNull();
      expect(id.dirty).toBeNull();
    } finally {
      rmSync(srcBuildInfo, { force: true });
    }
  });

  it('falls back without throwing on a corrupt build-info.json', () => {
    writeFileSync(srcBuildInfo, '{ not json', 'utf8');
    try {
      const id = getBuildIdentity();
      expect(id.commit).toBe('unknown'); // parse failed → unknown fallback
      expect(id.version).toBe(pkgVersion);
    } finally {
      rmSync(srcBuildInfo, { force: true });
    }
  });

  it('never spawns a subprocess at runtime — no git, no child_process (yrk.2 acceptance)', () => {
    // The load-bearing guarantee: build identity is stamped at BUILD time, so the
    // runtime reader must never shell out. Proving the module cannot spawn a
    // process proves it cannot invoke git.
    const src = readFileSync(resolve(__dirname, 'build-info.ts'), 'utf8');
    expect(src).not.toContain('child_process');
    expect(src).not.toMatch(/\b(execSync|execFileSync|execFile|spawnSync|spawn|exec)\s*\(/);
  });
});
