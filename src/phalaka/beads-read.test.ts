import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// Mock execFile before importing the accessor so all `bd` calls go through the spy.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: execFileMock }));

const {
  beadsRead,
  readKshetraTasks,
  readAllKshetraTasks,
  clearBeadsReadCache,
  isValidBeadId,
  BeadsReadError,
  LIST_CACHE_TTL_MS,
} = await import('./beads-read.js');

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { provider: 'anthropic', model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const KSHETRA_B: KshetraConfig = {
  ...KSHETRA,
  id: 'mandira',
  beads: { ...KSHETRA.beads, path: '/projects/mandira-beads' },
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
    dependencies: [
      { id: 'proj-0', title: 'Parent', type: 'parent-child' },
      { id: 'proj-9', title: 'Blocker', type: 'blocks' },
    ],
  },
]);

function mockSuccess(stdout: string) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockFailure(stderr: string) {
  const err = Object.assign(new Error('Command failed'), { stderr });
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(err, { stdout: '', stderr });
  });
}

function lastCall(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [cmd, args, opts] = execFileMock.mock.lastCall!;
  return { cmd, args, env: (opts as { env: NodeJS.ProcessEnv }).env };
}

beforeEach(() => {
  execFileMock.mockReset();
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
  it('runs `bd list --json` with BEADS_DIR set to the kshetra beads path', async () => {
    mockSuccess(LIST_JSON);
    const tasks = await beadsRead(KSHETRA).list();
    expect(lastCall().cmd).toBe('bd');
    expect(lastCall().args).toEqual(['list', '--json']);
    expect(lastCall().env['BEADS_DIR']).toBe('/projects/myapp-beads');
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

  it('passes a status filter through to bd', async () => {
    mockSuccess('[]');
    await beadsRead(KSHETRA).list({ status: 'closed' });
    expect(lastCall().args).toEqual(['list', '--json', '--status', 'closed']);
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
    expect(lastCall().args).toEqual(['show', 'proj-1', '--json']);
    expect(detail).toMatchObject({
      id: 'proj-1',
      description: 'Do the thing',
      notes: 'a note',
      design: 'a design',
      acceptance: 'it works',
      parent: 'proj-0',
      createdAt: '2026-06-28T00:00:00Z',
      blockedBy: ['proj-9'],
    });
    expect(detail!.dependencies).toHaveLength(2);
  });

  it('rejects an invalid bead id without shelling out', async () => {
    mockSuccess('[]');
    await expect(beadsRead(KSHETRA).show('--status closed')).rejects.toBeInstanceOf(BeadsReadError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns null when bd reports no matching bead', async () => {
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

  it('serves a cache hit within the TTL (no second bd call)', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    await beadsRead(KSHETRA).list();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires (cache miss)', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    vi.advanceTimersByTime(LIST_CACHE_TTL_MS + 1);
    await beadsRead(KSHETRA).list();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('keys the cache per Kshetra (no cross-contamination)', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    await beadsRead(KSHETRA_B).list();
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(lastCall().env['BEADS_DIR']).toBe('/projects/mandira-beads');
  });

  it('keys list and show separately and by status filter', async () => {
    mockSuccess(LIST_JSON);
    await beadsRead(KSHETRA).list();
    await beadsRead(KSHETRA).list({ status: 'closed' });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('per-Kshetra error isolation', () => {
  it('readKshetraTasks surfaces an error field instead of throwing', async () => {
    mockFailure('database is locked');
    const result = await readKshetraTasks(KSHETRA);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('bd list failed');
  });

  it('one failing Kshetra does not blank the others', async () => {
    // First kshetra fails, second succeeds.
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => {
      cb(Object.assign(new Error('fail'), { stderr: 'boom' }), { stdout: '', stderr: 'boom' });
    });
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => {
      cb(null, { stdout: LIST_JSON, stderr: '' });
    });

    const results = await readAllKshetraTasks([KSHETRA, KSHETRA_B]);
    expect(results).toHaveLength(2);
    expect('error' in results[0]!).toBe(true);
    expect('tasks' in results[1]!).toBe(true);
    if ('tasks' in results[1]!) expect(results[1]!.tasks).toHaveLength(1);
  });
});