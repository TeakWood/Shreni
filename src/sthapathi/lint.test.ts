import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// Mock execFile (callback-style, as promisify expects).
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => (mockExecFile as (...a: unknown[]) => void)(...args),
}));

const { runLintGate } = await import('./lint.js');

function ksh(stack: Partial<KshetraConfig['stack']> & { language: string }): KshetraConfig {
  return {
    id: 'myapp',
    repo: { path: '/projects/myapp' },
    stack,
  } as unknown as KshetraConfig;
}

function execResolves(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: (e: unknown, r?: unknown) => void) => {
    cb(null, { stdout, stderr });
  });
}
function execRejects(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: (e: unknown) => void) => {
    cb(Object.assign(new Error('exit 1'), { stdout, stderr }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runLintGate', () => {
  it('passes when the configured linter exits 0', async () => {
    execResolves('all good');
    const r = await runLintGate(ksh({ language: 'typescript', lintCommand: 'eslint .' }));
    expect(r).toEqual({ passed: true, skipped: false, raw: 'all good' });
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('eslint');
    expect(args).toEqual(['.']);
  });

  it('fails (passed=false) when the linter exits non-zero', async () => {
    execRejects('3 problems', '');
    const r = await runLintGate(ksh({ language: 'typescript', lintCommand: 'eslint .' }));
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.raw).toContain('3 problems');
  });

  it('uses the language default lint command when unset', async () => {
    execResolves();
    await runLintGate(ksh({ language: 'go' }));
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('go');
    expect(args).toEqual(['vet', './...']);
  });

  it('skips-and-logs (passed=true, skipped=true) when no lint command resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Unknown language has an empty default lint command.
    const r = await runLintGate(ksh({ language: 'brainfuck' }));
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lint gate skipped'));
    warn.mockRestore();
  });

  it('skips when lintCommand is explicitly set to empty (opt-out)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runLintGate(ksh({ language: 'typescript', lintCommand: '' }));
    expect(r.skipped).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});