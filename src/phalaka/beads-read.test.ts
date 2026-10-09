import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// The engine's reads, as withTrackerReads hands them over: every list/show goes
// through these spies, recorded with the Kshetra and the options it was read with.
type Call = { kshetra: string; shared?: boolean; op: 'list' | 'show'; arg: unknown };
const reads = vi.hoisted(() => ({
  calls: [] as { kshetra: string; shared?: boolean; op: 'list' | 'show'; arg: unknown }[],
  // Each read takes the next result; the last one repeats.
  results: [] as ({ ok: string } | { err: string })[],
}));
vi.mock('../policy/sthapathi/reads.js', () => ({
  withTrackerReads: async (k: { id: string }, fn: (r: unknown) => Promise<unknown>, opts: { shared?: boolean } = {}) => {
    const answer = (op: 'list' | 'show', arg: unknown) => {
      reads.calls.push({ kshetra: k.id, shared: opts.shared, op, arg });
      const r = reads.results.length > 1 ? reads.results.shift()! : reads.results[0];
      if (!r) return Promise.resolve('[]');
      return 'err' in r ? Promise.reject(new Error(r.err)) : Promise.resolve(r.ok);
    };
    return fn({ list: (f: unknown) => answer('list', f), show: (id: string) => answer('show', id) });
  },
}));

const {
  beadsRead,
  readKshetraTasks,
  readAllKshetraTasks,
  clearBeadsReadCache,
  invalidateProjectReads,
  isValidBeadId,
  BeadsReadError,
  LIST_CACHE_TTL_MS,
} = await import('./beads-read.js');

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  project: '0b9d6f4e-6a43-4c1e-9d77-2f6f3c1a9e10',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { provider: 'anthropic', model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

const KSHETRA_B: KshetraConfig = {
  ...KSHETRA,
  id: 'mandira',
  project: '5d1f2a6b-8c3e-4f70-a1b2-c3d4e5f60718',
};

const LIST_JSON = JSON.stringify([
  {
    id: 'proj-1',
    title: 'First task',
    status: 'open',
    priority: 1,
    issue_type: 'feature',
    owner: 'dev@example.com',
    updated_at: '2026-06-29T00:00:00Z',
    created_at: '2026-06-28T00:00:00Z',
  },
]);

const SHOW_JSON = JSON.stringify([
  {
    id: 'proj-1',
    title: 'First task',
    status: 'open',
    priority: 1,
    issue_type: 'feature',
    owner: 'dev@example.com',
    description: 'Do the thing',
    notes: 'a note',
    design: 'a design',
    acceptance_criteria: 'it works',
    created_at: '2026-06-28T00:00:00Z',
    updated_at: '2026-06-29T00:00:00Z',
    parent: 'proj-0',
    labels: ['pr-needs-followup', 'awaiting-merge'],
    dependencies: [
      { id: 'proj-0', title: 'Parent', type: 'parent-child' },
      { id: 'proj-9', title: 'Blocker', type: 'blocks' },
    ],
  },
]);

function mockSuccess(stdout: string) {
  reads.results = [{ ok: stdout }];
}

function mockFailure(message: string) {
  reads.results = [{ err: message }];
}

function lastCall(): Call {
  return reads.calls[reads.calls.length - 1]!;
}

beforeEach(() => {
  reads.calls = [];
  reads.results = [];
  clearBeadsReadCache();
});

describe('isValidBeadId', () => {
  it('accepts normal and dotted bead ids', () => {
    expect(isValidBeadId('myapp-beads-9g3')).toBe(true);
    expect(isValidBeadId('myapp-beads-9sk.6')).toBe(true);
    expect(isValidBeadId('proj-1')).toBe(true);
  });

  it('rejects injection-shaped ids', () => {
    expect(isValidBeadId('')).toBe(false);
    expect(isValidBeadId('--status closed')).toBe(false);
    expect(isValidBeadId('a b')).toBe(false);
    expect(isValidBeadId('../etc/passwd')).toBe(false);
    expect(isValidBeadId('a'.repeat(200))).toBe(false);
  });
});

describe('beadsRead().list', () => {
  it('lists through the engine\'s reads, on the shared connection Phalaka keeps', async () => {
    mockSuccess(LIST_JSON);
    const tasks = await beadsRead(KSHETRA).list();
    expect(lastCall()).toEqual({ kshetra: 'myapp', shared: true, op: 'list', arg: {} });
    expect(tasks).toEqual([
      {
        id: 'proj-1',
        title: 'First task',
        status: 'open',
        priority: 1,
        type: 'feature',
        assignee: 'dev@example.com',
        updatedAt: '2026-06-29T00:00:00Z',
      },
    ]);
  });

  it('passes a status filter through to the read', async () => {
    mockSuccess('[]');
    await beadsRead(KSHETRA).list({ status: 'closed' });
    expect(lastCall().arg).toEqual({ status: 'closed' });
  });

  it('passes a label filter through to the read', async () => {
    mockSuccess('[]');
    await beadsRead(KSHETRA).list({ label: 'pr-needs-followup' });
    expect(lastCall().arg).toEqual({ label: 'pr-needs-followup' });
  });

  it('wraps a failed read in BeadsReadError', async () => {
    mockFailure('connect ECONNREFUSED');
    await expect(beadsRead(KSHETRA).list()).rejects.toBeInstanceOf(BeadsReadError);
  });

  it('exposes no mutation methods on the surface', () => {
    mockSuccess('[]');
    const reader = beadsRead(KSHETRA) as Record<string, unknown>;
    expect(Object.keys(reader).sort()).toEqual(['list', 'show']);
    for (const m of ['claim', 'close', 'create', 'update', 'remember', 'addNote', 'flag']) {
      expect(reader[m]).toBeUndefined();
    }
  });
});

describe('beadsRead().show', () => {
  it('parses full detail including dependencies and blockedBy', async () => {
    mockSuccess(SHOW_JSON);
    const detail = await beadsRead(KSHETRA).show('proj-1');
    expect(lastCall()).toEqual({ kshetra: 'myapp', shared: true, op: 'show', arg: 'proj-1' });
    expect(detail).toMatchObject({
      id: 'proj-1',
      description: 'Do the thing',
      notes: 'a note',
      design: 'a design',
      acceptance: 'it works',
      parent: 'proj-0',
      createdAt: '2026-06-28T00:00:00Z',
      blockedBy: ['proj-9'],
      labels: ['pr-needs-followup', 'awaiting-merge'],
    });
    expect(detail!.dependencies).toHaveLength(2);
  });

  it('defaults labels to an empty array when the row omits them', async () => {
    mockSuccess(JSON.stringify([{ id: 'proj-2', title: 'No labels', status: 'open' }]));
    const detail = await beadsRead(KSHETRA).show('proj-2');
    expect(detail!.labels).toEqual([]);
  });

  it('rejects an invalid bead id without reading', async () => {
    mockSuccess('[]');
    await expect(beadsRead(KSHETRA).show('--status closed')).rejects.toBeInstanceOf(BeadsReadError);
    expect(reads.calls).toHaveLength(0);
  });

  it('returns null when the read finds no matching task', async () => {
    mockSuccess('[]');
    expect(await beadsRead(KSHETRA).show('proj-404')).toBeNull();
  });
});

describe('TTL cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a cache hit within the TTL (no second read)', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    await beadsRead(KSHETRA).list();
    expect(reads.calls).toHaveLength(1);
  });

  it('re-fetches within the TTL once the project\'s events dropped its reads', async () => {
    reads.results = [{ ok: '[]' }];
    await beadsRead(KSHETRA).list();
    invalidateProjectReads(KSHETRA.project!);
    await beadsRead(KSHETRA).list();
    expect(reads.calls.filter(c => c.op === 'list')).toHaveLength(2);
    // Another project's reads stay cached.
    invalidateProjectReads('another-project');
    await beadsRead(KSHETRA).list();
    expect(reads.calls.filter(c => c.op === 'list')).toHaveLength(2);
  });

  it('never caches a read that was in flight when the project\'s events dropped its reads', async () => {
    reads.results = [{ ok: '[]' }];
    const inFlight = beadsRead(KSHETRA).list();
    invalidateProjectReads(KSHETRA.project!); // the claim commits while the read runs
    await inFlight;
    await beadsRead(KSHETRA).list();
    expect(reads.calls.filter(c => c.op === 'list')).toHaveLength(2);
  });

  it('re-fetches after the TTL expires (cache miss)', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    vi.advanceTimersByTime(LIST_CACHE_TTL_MS + 1);
    await beadsRead(KSHETRA).list();
    expect(reads.calls).toHaveLength(2);
  });

  it('keys the cache per Kshetra (no cross-contamination)', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    await beadsRead(KSHETRA_B).list();
    expect(reads.calls).toHaveLength(2);
    expect(lastCall().kshetra).toBe('mandira');
  });

  it('keys list and show separately and by status filter', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    await beadsRead(KSHETRA).list({ status: 'closed' });
    expect(reads.calls).toHaveLength(2);
  });

  it('keys the cache by label so a label filter never returns the unfiltered slice', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list(); // unfiltered → key '...::default::'
    await beadsRead(KSHETRA).list({ label: 'pr-needs-followup' }); // → key '...::default::pr-needs-followup'
    expect(reads.calls).toHaveLength(2); // distinct keys, not a stale hit
  });
});

describe('per-Kshetra error isolation', () => {
  it('readKshetraTasks surfaces an error field instead of throwing', async () => {
    mockFailure('database is locked');
    const result = await readKshetraTasks(KSHETRA);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('task graph read failed: database is locked');
  });

  it('one failing Kshetra does not blank the others', async () => {
    // First kshetra fails, second succeeds.
    reads.results = [{ err: 'boom' }, { ok: LIST_JSON }];

    const results = await readAllKshetraTasks([KSHETRA, KSHETRA_B]);
    expect(results).toHaveLength(2);
    expect('error' in results[0]!).toBe(true);
    expect('tasks' in results[1]!).toBe(true);
    if ('tasks' in results[1]!) expect(results[1]!.tasks).toHaveLength(1);
  });
});