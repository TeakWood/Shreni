import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

// Drift guard (Shreni-beads-nhw). `shreni run` once built its own scheduler +
// hooks and so skipped every wiring the worker runtime performs — the ledger
// sink, persisted phase, heartbeat, recovery, timers — and a task it merged left
// no ledger trail. The fix made src/cli/worker-runtime.ts the ONLY place a
// scheduler is built for real work. This test fails if a second production
// createScheduler() call site appears, so the gap cannot quietly return.

const SRC = join(__dirname, '..');
// The definition itself, and the one sanctioned construction site.
const ALLOWED = new Set(['sthapathi/index.ts', 'cli/worker-runtime.ts']);

const rel = (p: string): string => relative(SRC, p).split(sep).join('/');

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // The Phalaka web app is a separate package and never drives agents.
      if (name === 'node_modules' || rel(p) === 'phalaka/web') continue;
      out.push(...productionSources(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('single scheduler construction site', () => {
  it('createScheduler() is called only by the worker runtime', () => {
    const offenders = productionSources(SRC)
      .filter(p => !ALLOWED.has(rel(p)))
      .filter(p => /\bcreateScheduler\s*\(/.test(readFileSync(p, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the worker runtime still builds its scheduler (the guard is not vacuous)', () => {
    expect(readFileSync(join(SRC, 'cli/worker-runtime.ts'), 'utf8')).toMatch(/\bcreateScheduler\s*\(/);
  });

  it('the bespoke manual-cycle module is gone', () => {
    expect(existsSync(join(SRC, 'cli/run.ts'))).toBe(false);
  });
});
