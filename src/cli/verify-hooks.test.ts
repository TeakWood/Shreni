import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockReadFileSync = vi.fn<(p: string, enc: string) => string>();
vi.mock('fs', () => ({ readFileSync: mockReadFileSync }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => '/home/test' };
});

// ── import after mocks ────────────────────────────────────────────────────────

const { verifyHooks, REQUIRED_COMMAND } = await import('./verify-hooks.js');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSettings(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }] }],
      PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }] }],
    },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('verifyHooks', () => {
  it('returns allPresent=true when both hooks are configured', () => {
    mockReadFileSync.mockReturnValue(makeSettings());
    const result = verifyHooks('/fake/settings.json');
    expect(result.sessionStart.present).toBe(true);
    expect(result.preCompact.present).toBe(true);
    expect(result.allPresent).toBe(true);
  });

  it('returns sessionStart.present=false when SessionStart hook is missing', () => {
    mockReadFileSync.mockReturnValue(makeSettings({
      hooks: {
        PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }] }],
      },
    }));
    const result = verifyHooks('/fake/settings.json');
    expect(result.sessionStart.present).toBe(false);
    expect(result.preCompact.present).toBe(true);
    expect(result.allPresent).toBe(false);
  });

  it('returns preCompact.present=false when PreCompact hook is missing', () => {
    mockReadFileSync.mockReturnValue(makeSettings({
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }] }],
      },
    }));
    const result = verifyHooks('/fake/settings.json');
    expect(result.sessionStart.present).toBe(true);
    expect(result.preCompact.present).toBe(false);
    expect(result.allPresent).toBe(false);
  });

  it('returns allPresent=false when settings file does not exist (ENOENT)', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFileSync.mockImplementation(() => { throw err; });
    const result = verifyHooks('/nonexistent/settings.json');
    expect(result.sessionStart.present).toBe(false);
    expect(result.preCompact.present).toBe(false);
    expect(result.allPresent).toBe(false);
  });

  it('throws when settings file cannot be read (non-ENOENT error)', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockReadFileSync.mockImplementation(() => { throw err; });
    expect(() => verifyHooks('/protected/settings.json')).toThrow('Cannot read settings');
  });

  it('returns false for hook configured with a different command', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'some other cmd' }] }],
        PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }] }],
      },
    }));
    const result = verifyHooks('/fake/settings.json');
    expect(result.sessionStart.present).toBe(false);
    expect(result.allPresent).toBe(false);
  });

  it('returns false when hooks key is absent from settings', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ model: 'sonnet' }));
    const result = verifyHooks('/fake/settings.json');
    expect(result.allPresent).toBe(false);
  });

  it(`REQUIRED_COMMAND is 'bd prime'`, () => {
    expect(REQUIRED_COMMAND).toBe('bd prime');
  });
});