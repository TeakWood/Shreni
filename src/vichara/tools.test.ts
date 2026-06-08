import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool } from './tools';
import type { KshetraConfig } from '../kshetra/config';

vi.mock('../sthapathi/beads.js', () => ({
  bd: vi.fn(() => ({
    show: vi.fn().mockResolvedValue('{"id":"abc","title":"Test bead"}'),
    list: vi.fn().mockResolvedValue('[{"id":"abc","title":"Test bead"}]'),
  })),
}));

vi.mock('../sthapathi/git.js', () => ({
  git: vi.fn(() => ({
    branchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts b/foo.ts\n+console.log("hi")'),
  })),
}));

vi.mock('../kshetra/state.js', () => ({
  loadState: vi.fn().mockReturnValue({
    kshetras: {
      'my-app': { paused: false },
      'paused-app': { paused: true, reason: 'cooldown', message: 'too many errors' },
    },
  }),
}));

const makeKshetra = (id: string, repoPath = '/repos/' + id): KshetraConfig =>
  ({
    id,
    name: id,
    repo: { path: repoPath, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: '/beads/' + id, remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  }) as unknown as KshetraConfig;

const kshetras = [makeKshetra('my-app'), makeKshetra('paused-app')];

beforeEach(() => vi.clearAllMocks());

describe('executeTool', () => {
  it('returns error for unknown kshetra', async () => {
    const result = await executeTool('get_bead', { kshetra_id: 'nope', id: 'x' }, kshetras);
    expect(result).toContain("kshetra 'nope' not found");
    expect(result).toContain('my-app');
  });

  it('get_bead delegates to bd.show', async () => {
    const { bd } = await import('../sthapathi/beads.js');
    const mockBd = vi.mocked(bd);
    const result = await executeTool('get_bead', { kshetra_id: 'my-app', id: 'abc-123' }, kshetras);
    expect(mockBd).toHaveBeenCalledWith(kshetras[0]);
    expect(result).toContain('abc');
  });

  it('list_beads delegates to bd.list with no filter', async () => {
    const { bd } = await import('../sthapathi/beads.js');
    const mockBd = vi.mocked(bd);
    await executeTool('list_beads', { kshetra_id: 'my-app' }, kshetras);
    const instance = mockBd.mock.results[0]!.value;
    expect(instance.list).toHaveBeenCalledWith({});
  });

  it('list_beads passes status filter', async () => {
    const { bd } = await import('../sthapathi/beads.js');
    const mockBd = vi.mocked(bd);
    await executeTool('list_beads', { kshetra_id: 'my-app', status: 'open' }, kshetras);
    const instance = mockBd.mock.results[0]!.value;
    expect(instance.list).toHaveBeenCalledWith({ status: 'open' });
  });

  it('get_agent_status returns JSON with paused flag', async () => {
    const result = await executeTool('get_agent_status', { kshetra_id: 'paused-app' }, kshetras);
    const parsed = JSON.parse(result);
    expect(parsed.paused).toBe(true);
    expect(parsed.reason).toBe('cooldown');
  });

  it('get_agent_status shows active when not paused', async () => {
    const result = await executeTool('get_agent_status', { kshetra_id: 'my-app' }, kshetras);
    const parsed = JSON.parse(result);
    expect(parsed.paused).toBe(false);
  });

  it('read_file returns file contents for a valid path', async () => {
    const result = await executeTool(
      'read_file',
      { kshetra_id: 'my-app', path: '../../../etc/passwd' },
      kshetras,
    );
    expect(result).toContain('Error: path is outside');
  });

  it('read_file returns error for nonexistent file', async () => {
    const result = await executeTool(
      'read_file',
      { kshetra_id: 'my-app', path: 'nonexistent.txt' },
      kshetras,
    );
    expect(result).toContain('Error:');
  });

  it('get_diff delegates to git.branchDiff', async () => {
    const result = await executeTool(
      'get_diff',
      { kshetra_id: 'my-app', branch: 'bead-abc/my-feature' },
      kshetras,
    );
    expect(result).toContain('diff --git');
  });

  it('returns error for unknown tool name', async () => {
    const result = await executeTool('unknown_tool', { kshetra_id: 'my-app' }, kshetras);
    expect(result).toContain("unknown tool 'unknown_tool'");
  });
});