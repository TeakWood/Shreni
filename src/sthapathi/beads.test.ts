import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// Mock execFile before importing beads so all calls go through our spy
const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: execFileMock }));

const { bd, syncBeads, BeadsError } = await import('./beads.js');

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: 'git@github.com:TeakWood/sishya.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: 'git@github.com:TeakWood/sishya-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

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
});

describe('bd() wrapper', () => {
  it('sets BEADS_DIR to kshetra.beads.path on every call', async () => {
    mockSuccess('[]');
    await bd(KSHETRA).ready();
    expect(lastCall().env['BEADS_DIR']).toBe('/projects/sishya-beads');
  });

  it('uses different BEADS_DIR for different Kshetras — no cross-contamination (2cw.2)', async () => {
    const KSHETRA_B = {
      ...KSHETRA,
      id: 'mandira',
      beads: { ...KSHETRA.beads, path: '/projects/mandira-beads' },
    };
    mockSuccess('[]');
    await bd(KSHETRA).ready();
    const envA = lastCall().env['BEADS_DIR'];

    mockSuccess('[]');
    await bd(KSHETRA_B).ready();
    const envB = lastCall().env['BEADS_DIR'];

    expect(envA).toBe('/projects/sishya-beads');
    expect(envB).toBe('/projects/mandira-beads');
    expect(envA).not.toBe(envB);
  });

  it('ready() calls bd ready --json', async () => {
    mockSuccess('[]');
    const result = await bd(KSHETRA).ready();
    expect(lastCall().args).toEqual(['ready', '--json']);
    expect(result).toBe('[]');
  });

  it('claim() calls bd update <id> --claim', async () => {
    mockSuccess('');
    await bd(KSHETRA).claim('bd-123');
    expect(lastCall().args).toEqual(['update', 'bd-123', '--claim']);
  });

  it('show() calls bd show <id> --json', async () => {
    mockSuccess('{}');
    await bd(KSHETRA).show('bd-123');
    expect(lastCall().args).toEqual(['show', 'bd-123', '--json']);
  });

  it('prime() calls bd prime', async () => {
    mockSuccess('context');
    await bd(KSHETRA).prime();
    expect(lastCall().args).toEqual(['prime']);
  });

  it('close() calls bd close <id> --reason <note>', async () => {
    mockSuccess('');
    await bd(KSHETRA).close('bd-123', 'Done');
    expect(lastCall().args).toEqual(['close', 'bd-123', 'Done']);
  });

  it('create() calls bd create with title, priority, and optional type', async () => {
    mockSuccess('bd-456');
    await bd(KSHETRA).create('Fix login', 1, 'bug');
    expect(lastCall().args).toEqual(['create', 'Fix login', '-p', '1', '-t', 'bug']);
  });

  it('create() omits -t when type is not provided', async () => {
    mockSuccess('bd-457');
    await bd(KSHETRA).create('Add feature', 2);
    expect(lastCall().args).toEqual(['create', 'Add feature', '-p', '2']);
  });

  it('remember() calls bd remember <insight>', async () => {
    mockSuccess('');
    await bd(KSHETRA).remember('use pnpm not npm');
    expect(lastCall().args).toEqual(['remember', 'use pnpm not npm']);
  });

  it('addNote() calls bd note <id> <text>', async () => {
    mockSuccess('');
    await bd(KSHETRA).addNote('bd-123', 'Round 1: dispatching Silpi');
    expect(lastCall().args).toEqual(['note', 'bd-123', 'Round 1: dispatching Silpi']);
  });

  it('flag() calls bd update <id> --status blocked --append-notes <reason>', async () => {
    mockSuccess('');
    await bd(KSHETRA).flag('bd-123', 'Max rounds exceeded');
    expect(lastCall().args).toEqual(['update', 'bd-123', '--status', 'blocked', '--append-notes', 'Max rounds exceeded']);
  });

  it('list() calls bd list --json with status filter', async () => {
    mockSuccess('[]');
    await bd(KSHETRA).list({ status: 'in_progress' });
    expect(lastCall().args).toEqual(['list', '--json', '--status', 'in_progress']);
  });

  it('throws BeadsError when bd command fails', async () => {
    mockFailure('database locked');
    await expect(bd(KSHETRA).ready()).rejects.toThrow(BeadsError);
    await expect(bd(KSHETRA).ready()).rejects.toThrow(/database locked/);
  });
});

describe('syncBeads', () => {
  it('calls pull --rebase, add -A, commit, and push in order', async () => {
    mockSuccess('');
    await syncBeads(KSHETRA);

    const calls = execFileMock.mock.calls.map((c: unknown[]) => (c as [string, string[]])[1]);
    expect(calls[0]).toEqual(['add', '-A']);
    expect(calls[1][0]).toBe('commit');
    expect(calls[1][1]).toBe('-m');
    expect(calls[1][2]).toMatch(/^shreni: sync \d{4}-/); // ISO timestamp
    expect(calls[2]).toEqual(['pull', '--rebase', 'origin', 'main']);
    expect(calls[3]).toEqual(['push', 'origin', 'main']);
  });

  it('continues through push even when commit is a no-op (nothing to commit)', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      callCount++;
      if (args[0] === 'commit') {
        const err = Object.assign(new Error('nothing to commit'), { stderr: 'nothing to commit, working tree clean' });
        cb(err, { stdout: '', stderr: 'nothing to commit, working tree clean' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    await expect(syncBeads(KSHETRA)).resolves.not.toThrow();
    // pull + add + commit(no-op) + push = 4 calls
    expect(callCount).toBe(4);
  });
});
