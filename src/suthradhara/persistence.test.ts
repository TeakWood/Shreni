import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Redirect the shreni home to a tmp dir before importing persistence — the
// module reads shreniDir() lazily each call, so this holds for every test.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'suthradhara-persistence-'));
process.env.HOME = TMP_ROOT;

const {
  suthradharaSessionsDir,
  sessionPath,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  generateSessionId,
  isValidSessionId,
  SessionNotFoundError,
  SessionSchemaError,
} = await import('./persistence');
const { newSessionState, SESSION_STATE_VERSION } = await import('./state');

beforeEach(() => {
  rmSync(suthradharaSessionsDir(), { recursive: true, force: true });
});
afterEach(() => {
  rmSync(suthradharaSessionsDir(), { recursive: true, force: true });
});

describe('generateSessionId / isValidSessionId', () => {
  it('embeds the kshetra id, a UTC timestamp, and a random suffix', () => {
    const id = generateSessionId('myapp', new Date(Date.UTC(2026, 6, 27, 14, 3, 12)), () => 'a3f2');
    expect(id).toBe('myapp-20260727T140312-a3f2');
    expect(isValidSessionId(id)).toBe(true);
  });

  it('rejects a traversal attempt', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionId('myapp/../..')).toBe(false);
  });
});

describe('save / load round-trip (slim record)', () => {
  it('persists and rehydrates the launched-session fields', () => {
    const id = 'myapp-20260727T140312-a3f2';
    const state = {
      ...newSessionState(id, 'myapp'),
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
      worktreePath: '/tmp/wt/suthradhara-' + id,
    };
    saveSession(state);
    const loaded = loadSession(id);
    expect(loaded.id).toBe(id);
    expect(loaded.kshetraId).toBe('myapp');
    expect(loaded.claudeSessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(loaded.worktreePath).toBe('/tmp/wt/suthradhara-' + id);
    expect(loaded.status).toBe('active');
  });

  it('throws SessionNotFoundError for a missing session', () => {
    expect(() => loadSession('myapp-20260727T140312-0000')).toThrow(SessionNotFoundError);
  });

  it('rejects an unsupported schema version rather than mis-hydrating', () => {
    const id = 'myapp-20260727T140312-a3f2';
    mkdirSync(suthradharaSessionsDir(), { recursive: true });
    writeFileSync(sessionPath(id), JSON.stringify({ version: 1, id, kshetraId: 'myapp' }), 'utf8');
    expect(() => loadSession(id)).toThrow(SessionSchemaError);
    expect(SESSION_STATE_VERSION).toBe(2);
  });
});

describe('listSessions', () => {
  it('summarises by status (not stage), newest id first, filtered by kshetra', () => {
    saveSession(newSessionState('myapp-20260101T000000-0001', 'myapp'));
    saveSession(newSessionState('myapp-20260201T000000-0002', 'myapp'));
    saveSession(newSessionState('other-20260101T000000-0003', 'other'));

    const mine = listSessions('myapp');
    expect(mine.map(s => s.id)).toEqual([
      'myapp-20260201T000000-0002',
      'myapp-20260101T000000-0001',
    ]);
    expect(mine[0].status).toBe('active');
    expect((mine[0] as Record<string, unknown>).stage).toBeUndefined();

    expect(listSessions().length).toBe(3);
  });

  it('deleteSession removes the record', () => {
    const id = 'myapp-20260101T000000-0001';
    saveSession(newSessionState(id, 'myapp'));
    deleteSession(id);
    expect(() => loadSession(id)).toThrow(SessionNotFoundError);
  });
});
