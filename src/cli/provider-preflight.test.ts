import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delimiter, join } from 'path';

const mockExistsSync = vi.fn<(p: string) => boolean>();
vi.mock('fs', () => ({ existsSync: (p: string) => mockExistsSync(p) }));

const { commandExists, checkProviderInstalled, findRoleCredentialGaps } = await import('./provider-preflight');

// Minimal fixture — findRoleCredentialGaps only reads kshetra.agents.
function kshetraWith(agents: Record<string, unknown>): import('../kshetra/config').KshetraConfig {
  return { agents } as unknown as import('../kshetra/config').KshetraConfig;
}

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

describe('findRoleCredentialGaps (b0f.3)', () => {
  const flatAnthropic = { provider: 'anthropic', model: 'claude-sonnet-4-6' };

  it('reports no gap for the Anthropic subscription default even without a key', () => {
    const gaps = findRoleCredentialGaps(kshetraWith(flatAnthropic), {});
    expect(gaps).toEqual([]);
  });

  it('flags a per-role Codex reviewer with no OPENAI_API_KEY', () => {
    const kshetra = kshetraWith({ ...flatAnthropic, viharapala: { provider: 'openai', model: 'gpt-5-codex' } });
    const gaps = findRoleCredentialGaps(kshetra, {});
    expect(gaps).toHaveLength(1);
    expect(gaps[0].provider).toBe('openai');
    expect(gaps[0].roles).toEqual(['viharapala']);
    expect(gaps[0].message).toContain('OPENAI_API_KEY');
  });

  it('passes once OPENAI_API_KEY is set', () => {
    const kshetra = kshetraWith({ ...flatAnthropic, viharapala: { provider: 'openai', model: 'gpt-5-codex' } });
    expect(findRoleCredentialGaps(kshetra, { OPENAI_API_KEY: 'sk-test' })).toEqual([]);
  });

  it('treats a blank key env var as missing', () => {
    const kshetra = kshetraWith({ ...flatAnthropic, silpi: { provider: 'openai', model: 'gpt-5-codex' } });
    expect(findRoleCredentialGaps(kshetra, { OPENAI_API_KEY: '   ' })).toHaveLength(1);
  });

  it('accepts either GEMINI_API_KEY or GOOGLE_API_KEY for gemini', () => {
    const kshetra = kshetraWith({ ...flatAnthropic, parikshaka: { provider: 'gemini', model: 'gemini-2.5-pro' } });
    expect(findRoleCredentialGaps(kshetra, { GOOGLE_API_KEY: 'g-test' })).toEqual([]);
    expect(findRoleCredentialGaps(kshetra, { GEMINI_API_KEY: 'g-test' })).toEqual([]);
    expect(findRoleCredentialGaps(kshetra, {})).toHaveLength(1);
  });

  it('groups multiple roles on the same missing provider into one gap', () => {
    const kshetra = kshetraWith({
      ...flatAnthropic,
      viharapala: { provider: 'openai', model: 'gpt-5-codex' },
      parikshaka: { provider: 'openai', model: 'gpt-5-codex' },
    });
    const gaps = findRoleCredentialGaps(kshetra, {});
    expect(gaps).toHaveLength(1);
    expect(gaps[0].roles).toEqual(expect.arrayContaining(['viharapala', 'parikshaka']));
  });
});