import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `shreni run` is a thin alias for `shreni drain --max-cycles 1` (Shreni-beads-nhw):
// the command must route through runDrain — the real worker runtime — with a
// one-cycle cap, forwarding --label and --allow-ablation, and exit with drain's
// machine-readable code.

const mockRunDrain = vi.fn();
vi.mock('./drain', async importOriginal => ({
  ...(await importOriginal<typeof import('./drain')>()),
  runDrain: (...args: unknown[]) => mockRunDrain(...args),
}));

const { COMMANDS, parseMaxCycles } = await import('./commands.js');
const { makeContext } = await import('./registry.js');

const RESULT = {
  exitCode: 12, reason: 'capped', openInScope: ['b2'], stalled: [],
  kshetra: 'myapp', lotId: 'lot-1', scope: null, labels: {}, maxCycles: 1,
  elapsedMs: 5, counts: { filed: 0, merged: 1, open: 1 }, outOfScopeFiled: [],
};

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mockRunDrain.mockReset().mockResolvedValue(RESULT);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const cmd = (name: string) => COMMANDS.find(c => c.name === name)!;

describe('shreni run (alias for drain --max-cycles 1)', () => {
  it('runs a one-cycle drain with entrypoint run, forwarding --label and --allow-ablation', async () => {
    await cmd('run').run(makeContext(['--kshetra', 'myapp', '--label', 'arm=A', '--allow-ablation']));
    expect(mockRunDrain).toHaveBeenCalledWith('myapp', {
      maxCycles: 1, entrypoint: 'run', labels: { arm: 'A' }, allowAblation: true,
    });
    expect(exitSpy).toHaveBeenCalledWith(12); // drain's exit code, not "Cycle complete."
  });

  it.each([['--epic', 'e1'], ['--max-cycles', '3']])('refuses the drain-only flag %s instead of ignoring it', (f, v) => {
    expect(() => cmd('run').run(makeContext(['--kshetra', 'myapp', f, v]))).toThrow(`does not take ${f}`);
    expect(mockRunDrain).not.toHaveBeenCalled();
  });

  it('--help states what the command now is, without running anything', async () => {
    await cmd('run').run(makeContext(['--help']));
    expect(mockRunDrain).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('shreni drain --max-cycles 1');
    expect(cmd('run').summary).toContain('drain --max-cycles 1');
  });

  it('requires --kshetra', () => {
    expect(() => cmd('run').run(makeContext([]))).toThrow(/Usage: shreni run/);
  });
});

describe('shreni drain --max-cycles', () => {
  it('passes the parsed cap to runDrain', async () => {
    await cmd('drain').run(makeContext(['--kshetra', 'myapp', '--max-cycles', '3']));
    expect(mockRunDrain).toHaveBeenCalledWith('myapp', expect.objectContaining({ maxCycles: 3, allowAblation: false }));
  });

  it('is uncapped when the flag is absent', async () => {
    await cmd('drain').run(makeContext(['--kshetra', 'myapp']));
    expect(mockRunDrain.mock.calls[0][1].maxCycles).toBeUndefined();
  });

  it.each([['0'], ['-2'], ['1.5'], ['abc'], ['--json']])('rejects --max-cycles %s', raw => {
    expect(() => parseMaxCycles(makeContext(['--max-cycles', raw]))).toThrow(/positive integer/);
  });

  it('rejects a bare --max-cycles with no value', () => {
    expect(() => parseMaxCycles(makeContext(['--max-cycles']))).toThrow(/positive integer/);
  });
});
