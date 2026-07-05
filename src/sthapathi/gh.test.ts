import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execFile before importing gh so every call goes through our spy.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: execFileMock }));

const { gh, GhError } = await import('./gh.js');

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

function lastCall(): { cmd: string; args: string[]; cwd: string } {
  const [cmd, args, opts] = execFileMock.mock.lastCall!;
  return { cmd, args, cwd: (opts as { cwd: string }).cwd };
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('gh() wrapper', () => {
  it('prCreate runs gh pr create in the repo dir and returns the PR url', async () => {
    mockSuccess('https://github.com/TeakWood/myapp/pull/7');
    const url = await gh('/projects/myapp').prCreate({
      base: 'main',
      head: 'bead-x/fix',
      title: 'Fix (x)',
      body: 'body',
    });
    expect(url).toBe('https://github.com/TeakWood/myapp/pull/7');
    const { cmd, args, cwd } = lastCall();
    expect(cmd).toBe('gh');
    expect(args).toEqual([
      'pr', 'create', '--base', 'main', '--head', 'bead-x/fix', '--title', 'Fix (x)', '--body', 'body',
    ]);
    expect(cwd).toBe('/projects/myapp');
  });

  it('prCreate returns only the URL line when gh prints extra output', async () => {
    mockSuccess('Warning: something\nhttps://github.com/TeakWood/myapp/pull/9');
    const url = await gh('/projects/myapp').prCreate({ base: 'main', head: 'b', title: 't', body: 'b' });
    expect(url).toBe('https://github.com/TeakWood/myapp/pull/9');
  });

  it('prCreate falls back to the existing PR url when one already exists (idempotent)', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[1] === 'create') {
        cb(Object.assign(new Error('failed'), { stderr: 'a pull request for branch "b" already exists' }), { stdout: '', stderr: '' });
      } else {
        // gh pr view --json
        cb(null, { stdout: JSON.stringify({ state: 'OPEN', url: 'https://github.com/TeakWood/myapp/pull/3' }), stderr: '' });
      }
    });
    const url = await gh('/projects/myapp').prCreate({ base: 'main', head: 'b', title: 't', body: 'b' });
    expect(url).toBe('https://github.com/TeakWood/myapp/pull/3');
  });

  it('prCreate rethrows a non-duplicate failure as GhError', async () => {
    mockFailure('not authenticated');
    await expect(gh('/projects/myapp').prCreate({ base: 'main', head: 'b', title: 't', body: 'b' }))
      .rejects.toBeInstanceOf(GhError);
  });

  it('prView parses state + url', async () => {
    mockSuccess(JSON.stringify({ state: 'MERGED', url: 'https://github.com/TeakWood/myapp/pull/5' }));
    const pr = await gh('/projects/myapp').prView('bead-x/fix');
    expect(pr).toEqual({ state: 'MERGED', url: 'https://github.com/TeakWood/myapp/pull/5' });
    expect(lastCall().args).toEqual(['pr', 'view', 'bead-x/fix', '--json', 'state,url']);
  });

  it('prView returns null when there is no PR / gh fails', async () => {
    mockFailure('no pull requests found for branch');
    const pr = await gh('/projects/myapp').prView('bead-x/fix');
    expect(pr).toBeNull();
  });
});