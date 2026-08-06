import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KshetraConfig } from '../kshetra/config';
import type { SpawnSpec } from '../agents/providers/types';

// Real HOME → tmp so real pid/persistence I/O is isolated. repo.path must exist
// (assertRepoExists), so point it at the tmp root too.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'suthradhara-lifecycle-'));
process.env.HOME = TMP_ROOT;

// Only the worktree module is mocked (it shells out to git); everything else is
// real, driven through the spawn/uuid seams.
const h = vi.hoisted(() => ({
  create: vi.fn(async (_k: unknown, sid: string) => `/tmp/wt/suthradhara-${sid}`),
  reap: vi.fn(async () => [] as string[]),
}));
vi.mock('./worktree', () => ({
  createSessionWorktree: h.create,
  reapSessionWorktrees: h.reap,
}));

const {
  startSession,
  resumeSession,
  teardownWorktrees,
} = await import('./lifecycle');
const { saveSession, loadSession } = await import('./persistence');
const { newSessionState } = await import('./state');
const pid = await import('./pid');

const KSHETRA = {
  id: 'myapp',
  repo: { path: TMP_ROOT, remote: 'git@github.com:me/myapp.git', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads/.beads', remote: 'git@github.com:me/myapp-beads.git' },
  agents: { model: 'claude-opus-4-8' },
  mcp: { servers: {} },
} as unknown as KshetraConfig;

// A spawn seam that records the spec + cwd and lets the test control exit timing.
function recordingSpawn() {
  const calls: { spec: SpawnSpec; cwd: string }[] = [];
  let resolveExit!: (code: number) => void;
  const seam = (spec: SpawnSpec, cwd: string) => {
    calls.push({ spec, cwd });
    return {
      pid: 4242,
      wait: () => new Promise<number>((r) => { resolveExit = r; }),
    };
  };
  return { seam, calls, endSession: (code = 0) => resolveExit(code) };
}

beforeEach(() => {
  h.create.mockClear();
  h.reap.mockClear();
  pid.clearSuthradharaPid(KSHETRA.id);
});
afterEach(() => {
  pid.clearSuthradharaPid(KSHETRA.id);
});

describe('startSession — fresh planning unit', () => {
  it('creates a worktree, persists ids, and launches an interactive claude', async () => {
    const sp = recordingSpawn();
    const result = await startSession(KSHETRA, { spawn: sp.seam, uuid: () => 'fixed-uuid-0000' });

    expect(result.status).toBe('launched');
    if (result.status !== 'launched') return;
    expect(result.pid).toBe(4242);
    expect(result.claudeSessionId).toBe('fixed-uuid-0000');
    expect(h.create).toHaveBeenCalledOnce();
    expect(pid.readSuthradharaPid(KSHETRA.id)).toBe(4242);

    // Persisted record carries the launched-session fields.
    const saved = loadSession(result.sessionId);
    expect(saved.claudeSessionId).toBe('fixed-uuid-0000');
    expect(saved.worktreePath).toBe(result.worktreePath);

    // The spawn got an interactive spec pinned to the session id, in the worktree.
    expect(sp.calls[0].cwd).toBe(result.worktreePath);
    expect(sp.calls[0].spec.args).toContain('--session-id');
    expect(sp.calls[0].spec.args).toContain('fixed-uuid-0000');
    expect(sp.calls[0].spec.args).not.toContain('-p');
  });

  it('clears the pid when the session exits (wait resolves)', async () => {
    const sp = recordingSpawn();
    const result = await startSession(KSHETRA, { spawn: sp.seam, uuid: () => 'u' });
    if (result.status !== 'launched') throw new Error('expected launch');
    const waited = result.wait();
    sp.endSession(0);
    await waited;
    expect(pid.readSuthradharaPid(KSHETRA.id)).toBeNull();
  });

  it('reuses a given worktree (the "extend" path) instead of creating one', async () => {
    const sp = recordingSpawn();
    const reuse = mkdtempSync(join(tmpdir(), 'reuse-wt-'));
    const result = await startSession(KSHETRA, {
      spawn: sp.seam, uuid: () => 'u2',
      reuseWorktree: reuse, extendDocRelPath: '.shreni/design/sso.md',
    });
    if (result.status !== 'launched') throw new Error('expected launch');
    expect(h.create).not.toHaveBeenCalled();
    expect(result.worktreePath).toBe(reuse);
    // The extend seed reaches the appended system prompt.
    const sys = sp.calls[0].spec.args[sp.calls[0].spec.args.indexOf('--append-system-prompt') + 1];
    expect(sys).toContain('.shreni/design/sso.md');
    rmSync(reuse, { recursive: true, force: true });
  });

  it('refuses to launch when a live session already holds the pid', async () => {
    pid.writeSuthradharaPid(KSHETRA.id, process.pid); // a definitely-alive pid
    const sp = recordingSpawn();
    const result = await startSession(KSHETRA, { spawn: sp.seam, uuid: () => 'u3' });
    expect(result.status).toBe('already_running');
    expect(sp.calls.length).toBe(0);
  });
});

describe('resumeSession', () => {
  it('reattaches via --resume when the session has a claude session id', async () => {
    const id = 'myapp-20260101T000000-0001';
    saveSession({ ...newSessionState(id, 'myapp'), claudeSessionId: 'prior-uuid' });
    const sp = recordingSpawn();
    const result = await resumeSession(KSHETRA, id, { spawn: sp.seam });
    if (result.status !== 'launched') throw new Error('expected launch');
    expect(sp.calls[0].spec.args).toContain('--resume');
    expect(sp.calls[0].spec.args).toContain('prior-uuid');
    expect(sp.calls[0].spec.args).not.toContain('--session-id');
  });

  it('starts fresh (pins a new id) when the session never launched', async () => {
    const id = 'myapp-20260101T000000-0002';
    saveSession(newSessionState(id, 'myapp'));
    const sp = recordingSpawn();
    const result = await resumeSession(KSHETRA, id, { spawn: sp.seam, uuid: () => 'new-uuid' });
    if (result.status !== 'launched') throw new Error('expected launch');
    expect(sp.calls[0].spec.args).toContain('--session-id');
    expect(sp.calls[0].spec.args).toContain('new-uuid');
    expect(sp.calls[0].spec.args).not.toContain('--resume');
  });
});

describe('teardownWorktrees', () => {
  it('reaps the kshetra worktrees', async () => {
    await teardownWorktrees(KSHETRA);
    expect(h.reap).toHaveBeenCalledWith(KSHETRA);
  });
});
