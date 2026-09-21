import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';

const HOME = '/home/tester';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => HOME };
});

const {
  kshetraStateLocations,
  kshetraDir,
  stateFilePath,
  ragIndexDir,
  kshetraRagSlug,
  legacyLogPath,
} = await import('./state-locations.js');

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads', remote: '' },
  agents: { maxRoundsPerBead: 5 },
} as unknown as import('./config.js').KshetraConfig;

describe('path helpers', () => {
  it('derives every ~/.shreni path from homedir', () => {
    expect(kshetraDir('myapp')).toBe(join(HOME, '.shreni', 'kshetra', 'myapp'));
    expect(stateFilePath()).toBe(join(HOME, '.shreni', 'state.json'));
    expect(ragIndexDir('myapp')).toBe(join(HOME, '.shreni', 'rag', 'myapp'));
    expect(legacyLogPath('myapp')).toBe(join(HOME, '.shreni', 'logs', 'myapp.jsonl'));
  });

  it('resolves the RAG slug through the id→slug mapping (id IS the slug)', () => {
    expect(kshetraRagSlug(KSHETRA)).toBe('myapp');
    // The RAG path must go through the mapping, not assume id == slug at the site.
    expect(ragIndexDir(kshetraRagSlug(KSHETRA))).toBe(ragIndexDir('myapp'));
  });
});

describe('kshetraStateLocations', () => {
  const locs = kshetraStateLocations(KSHETRA);
  const byKey = Object.fromEntries(locs.map(l => [l.key, l]));

  it('returns the beads dir, runtime dir, flags slice, RAG index and legacy log', () => {
    expect(Object.keys(byKey).sort()).toEqual(
      ['beads', 'flags', 'legacy-log', 'rag', 'runtime'].sort(),
    );
  });

  it('keys unique, one role each', () => {
    expect(new Set(locs.map(l => l.key)).size).toBe(locs.length);
  });

  it('beads points at the whole configured beads dir and is required', () => {
    expect(byKey.beads).toMatchObject({
      path: '/projects/myapp-beads',
      kind: 'dir',
      role: 'beads',
      required: true,
    });
  });

  it('runtime is the per-kshetra dir, optional', () => {
    expect(byKey.runtime).toMatchObject({
      path: kshetraDir('myapp'),
      kind: 'dir',
      role: 'runtime',
      required: false,
    });
  });

  it('flags is a json-slice of the shared state file keyed by this kshetra id only', () => {
    expect(byKey.flags).toMatchObject({
      path: stateFilePath(),
      kind: 'json-slice',
      role: 'flags',
      required: false,
      sliceKey: 'myapp',
    });
    // The slice key must be THIS kshetra's id — restore rewrites only this entry.
    const other = kshetraStateLocations({ ...KSHETRA, id: 'other' } as typeof KSHETRA);
    expect(other.find(l => l.key === 'flags')?.sliceKey).toBe('other');
  });

  it('rag resolves through the id→slug mapping', () => {
    expect(byKey.rag).toMatchObject({
      path: ragIndexDir(kshetraRagSlug(KSHETRA)),
      kind: 'dir',
      role: 'index',
      required: false,
    });
  });

  it('only the flags entry carries a sliceKey', () => {
    for (const l of locs) {
      if (l.kind === 'json-slice') expect(l.sliceKey).toBeTruthy();
      else expect(l.sliceKey).toBeUndefined();
    }
  });

  it('does NOT snapshot the work repo (driver owns it via git)', () => {
    expect(locs.some(l => l.path === KSHETRA.repo.path)).toBe(false);
  });

  it('every machine-side location lives under ~/.shreni', () => {
    for (const l of locs) {
      if (l.role === 'beads') continue; // project-side, configured absolute path
      expect(l.path.startsWith(join(HOME, '.shreni'))).toBe(true);
    }
  });
});

// Guard (finding 4 / AC): no module may derive a Kshetra's ~/.shreni path or
// redefine kshetraDir / state.json outside this single-source module. If a new
// per-kshetra state file is added elsewhere without routing through
// state-locations.ts, one of these greps trips.
describe('single-source guard', () => {
  const SRC = new URL('..', import.meta.url).pathname; // src/
  const SELF = 'state-locations.ts';

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'node_modules' || name === '.git') continue;
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  const files = walk(SRC).filter(
    f => !f.endsWith('.test.ts') && !f.endsWith(SELF),
  );

  it('kshetraDir is defined exactly once (in state-locations.ts)', () => {
    const offenders = files.filter(f =>
      /function\s+kshetraDir\s*\(/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('state.json path is derived only through stateFilePath()', () => {
    const offenders = files.filter(f =>
      /['"]state\.json['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the ~/.shreni/rag path is derived only through ragIndexDir()', () => {
    const offenders = files.filter(f => {
      const src = readFileSync(f, 'utf8');
      return /['"]\.shreni['"][^\n]*['"]rag['"]/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
