import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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

describe('generateSessionId', () => {
  it('embeds the kshetra id, a UTC timestamp, and a random suffix', () => {
    const id = generateSessionId(
      'myapp',
      new Date(Date.UTC(2026, 6, 27, 14, 3, 12)),
      () => 'a3f2',
    );
    expect(id).toBe('myapp-20260727T140312-a3f2');
    expect(isValidSessionId(id)).toBe(true);
  });

  it('produces ids that sort by time (later > earlier lexicographically)', () => {
    const rand = () => '0000';
    const early = generateSessionId('myapp', new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), rand);
    const late = generateSessionId('myapp', new Date(Date.UTC(2026, 11, 31, 23, 59, 59)), rand);
    expect(late > early).toBe(true);
  });
});

describe('isValidSessionId', () => {
  it('accepts a well-formed id', () => {
    expect(isValidSessionId('myapp-20260727T140312-a3f2')).toBe(true);
  });

  it('rejects a traversal attempt', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionId('myapp/../..')).toBe(false);
  });

  it('rejects a hand-typed id missing the timestamp', () => {
    expect(isValidSessionId('myapp')).toBe(false);
  });
});

describe('saveSession / loadSession round trip', () => {
  it('restores stage, rubric, and running requirement set intact', () => {
    const state = newSessionState('myapp-20260727T140312-a3f2', 'myapp');
    state.stage = 'clarify';
    state.rubric.intent = true;
    state.rubric.usersStories = true;
    state.requirements = ['operator can pause a bead', 'pause survives worker restart'];
    state.openQuestions = [{ id: 'Q1', question: 'concurrency?', raisedAt: '2026-07-27T10:00:00.000Z' }];
    state.transcript = [
      { role: 'user', content: 'let’s design pause', at: '2026-07-27T10:00:00.000Z' },
      { role: 'assistant', content: 'what should happen mid-bead?', at: '2026-07-27T10:00:05.000Z' },
    ];

    saveSession(state);
    const loaded = loadSession(state.id);

    expect(loaded.stage).toBe('clarify');
    expect(loaded.rubric).toEqual(state.rubric);
    expect(loaded.requirements).toEqual(state.requirements);
    expect(loaded.openQuestions).toEqual(state.openQuestions);
    expect(loaded.transcript).toEqual(state.transcript);
    expect(loaded.kshetraId).toBe('myapp');
  });

  it('always stamps updatedAt at save time', () => {
    const state = newSessionState('myapp-20260727T140312-a3f2', 'myapp', '2026-01-01T00:00:00.000Z');
    saveSession(state);
    const loaded = loadSession(state.id);
    expect(loaded.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(loaded.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('writes atomically — no .tmp remains after a successful save', () => {
    const state = newSessionState('myapp-20260727T140312-a3f2', 'myapp');
    saveSession(state);
    expect(existsSync(`${sessionPath(state.id)}.tmp`)).toBe(false);
    expect(existsSync(sessionPath(state.id))).toBe(true);
  });

  it('creates the sessions directory on first save', () => {
    rmSync(suthradharaSessionsDir(), { recursive: true, force: true });
    const state = newSessionState('myapp-20260727T140312-a3f2', 'myapp');
    saveSession(state);
    expect(existsSync(sessionPath(state.id))).toBe(true);
  });
});

describe('loadSession errors', () => {
  it('throws SessionNotFoundError for an unknown id', () => {
    expect(() => loadSession('myapp-20260727T140312-ffff')).toThrow(SessionNotFoundError);
  });

  it('rejects a malformed session id without touching the filesystem', () => {
    expect(() => loadSession('../etc/passwd')).toThrow(SessionSchemaError);
  });

  it('rejects a foreign schema version', () => {
    mkdirSync(suthradharaSessionsDir(), { recursive: true });
    const id = 'myapp-20260727T140312-a3f2';
    writeFileSync(
      sessionPath(id),
      JSON.stringify({ version: 999, id, kshetraId: 'myapp' }),
      'utf8',
    );
    expect(() => loadSession(id)).toThrow(/unsupported schema version/);
  });

  it('rejects a file whose stored id does not match its filename', () => {
    mkdirSync(suthradharaSessionsDir(), { recursive: true });
    const id = 'myapp-20260727T140312-a3f2';
    writeFileSync(
      sessionPath(id),
      JSON.stringify({ version: SESSION_STATE_VERSION, id: 'other', kshetraId: 'myapp' }),
      'utf8',
    );
    expect(() => loadSession(id)).toThrow(/id mismatch/);
  });

  it('rejects invalid JSON with a helpful message', () => {
    mkdirSync(suthradharaSessionsDir(), { recursive: true });
    const id = 'myapp-20260727T140312-a3f2';
    writeFileSync(sessionPath(id), '{not json', 'utf8');
    expect(() => loadSession(id)).toThrow(/invalid JSON/);
  });
});

describe('listSessions', () => {
  it('returns [] when the sessions directory does not exist', () => {
    rmSync(suthradharaSessionsDir(), { recursive: true, force: true });
    expect(listSessions()).toEqual([]);
  });

  it('returns summaries newest-first (by session id timestamp)', () => {
    const early = newSessionState('myapp-20260101T000000-aaaa', 'myapp');
    const late = newSessionState('myapp-20261231T235959-bbbb', 'myapp');
    saveSession(early);
    saveSession(late);
    const summaries = listSessions();
    expect(summaries.map(s => s.id)).toEqual([late.id, early.id]);
  });

  it('filters to a single kshetra when requested', () => {
    saveSession(newSessionState('myapp-20260101T000000-aaaa', 'myapp'));
    saveSession(newSessionState('other-20260101T000000-bbbb', 'other'));
    expect(listSessions('myapp').map(s => s.kshetraId)).toEqual(['myapp']);
  });

  it('ignores stray files that do not look like a session id', () => {
    mkdirSync(suthradharaSessionsDir(), { recursive: true });
    writeFileSync(join(suthradharaSessionsDir(), 'README.md'), 'noise', 'utf8');
    writeFileSync(join(suthradharaSessionsDir(), 'garbage.json'), '{}', 'utf8');
    expect(listSessions()).toEqual([]);
  });
});

describe('deleteSession', () => {
  it('removes an existing session and is idempotent on a missing one', () => {
    const state = newSessionState('myapp-20260727T140312-a3f2', 'myapp');
    saveSession(state);
    deleteSession(state.id);
    expect(existsSync(sessionPath(state.id))).toBe(false);
    expect(() => deleteSession(state.id)).not.toThrow();
  });

  it('silently ignores a malformed id (no filesystem touch)', () => {
    expect(() => deleteSession('../etc/passwd')).not.toThrow();
  });
});
