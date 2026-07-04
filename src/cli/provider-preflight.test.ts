import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delimiter, join } from 'path';

const mockExistsSync = vi.fn<(p: string) => boolean>();
vi.mock('fs', () => ({ existsSync: (p: string) => mockExistsSync(p) }));

const { commandExists, checkProviderInstalled } = await import('./provider-preflight');

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

describe('commandExists', () => {
  it('checks an absolute bin path directly (SHRENI_*_BIN override)', () => {
    mockExistsSync.mockImplementation(p => p === '/opt/tools/claude');
    expect(commandExists('/opt/tools/claude', {})).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith('/opt/tools/claude');
  });

  it('returns false when an absolute override path is missing', () => {
    expect(commandExists('/opt/tools/claude', {})).toBe(false);
  });

  it('scans PATH for a bare command name', () => {
    const env = { PATH: ['/usr/bin', '/usr/local/bin'].join(delimiter) };
    mockExistsSync.mockImplementation(p => p === join('/usr/local/bin', 'gemini'));
    expect(commandExists('gemini', env)).toBe(true);
  });

  it('returns false when the command is on no PATH dir', () => {
    const env = { PATH: ['/usr/bin', '/usr/local/bin'].join(delimiter) };
    expect(commandExists('gemini', env)).toBe(false);
  });

  it('returns false with an empty PATH', () => {
    expect(commandExists('claude', { PATH: '' })).toBe(false);
  });
});

describe('checkProviderInstalled', () => {
  const PATH_ENV = { PATH: '/usr/local/bin' };

  it('is ok when the provider CLI is on PATH', () => {
    mockExistsSync.mockImplementation(p => p === join('/usr/local/bin', 'claude'));
    const res = checkProviderInstalled('anthropic', PATH_ENV);
    expect(res.ok).toBe(true);
    expect(res.bin).toBe('claude');
    expect(res.message).toBeUndefined();
  });

  it('fails with install guidance when the CLI is missing', () => {
    const res = checkProviderInstalled('gemini', PATH_ENV);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('npm install -g @google/gemini-cli');
    expect(res.message).toContain('https://');
    expect(res.message).toContain('SHRENI_GEMINI_BIN');
    expect(res.message).toContain('shreni init-kshetra --provider gemini');
  });

  it('honours the SHRENI_*_BIN override when probing', () => {
    const prev = process.env.SHRENI_CODEX_BIN;
    process.env.SHRENI_CODEX_BIN = '/custom/codex';
    mockExistsSync.mockImplementation(p => p === '/custom/codex');
    try {
      const res = checkProviderInstalled('openai', PATH_ENV);
      expect(res.ok).toBe(true);
      expect(res.bin).toBe('/custom/codex');
    } finally {
      if (prev === undefined) delete process.env.SHRENI_CODEX_BIN;
      else process.env.SHRENI_CODEX_BIN = prev;
    }
  });
});