import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeContext, renderHelp, dispatch, type Command } from './registry.js';

// A tiny fixture registry so dispatcher behavior is tested in isolation from the
// real commands (those have their own tests).
function fixtureCommands(spy: { calls: unknown[] }): Command[] {
  return [
    {
      name: 'greet',
      summary: 'say hi',
      usage: '--name <n>',
      run(ctx) {
        spy.calls.push(ctx.flag('--name'));
      },
    },
    {
      name: 'boom',
      summary: 'always throws',
      run() {
        throw new Error('kaboom');
      },
    },
    {
      name: 'wait',
      summary: 'async ok',
      async run() {
        await Promise.resolve();
        spy.calls.push('waited');
      },
    },
  ];
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('makeContext', () => {
  it('reads flag values, positional args, and boolean presence', () => {
    const ctx = makeContext(['--name', 'ada', '--all', 'pos']);
    expect(ctx.flag('--name')).toBe('ada');
    expect(ctx.has('--all')).toBe(true);
    expect(ctx.has('--missing')).toBe(false);
    expect(ctx.flag('--missing')).toBeUndefined();
    expect(ctx.args[3]).toBe('pos');
  });

  it('returns undefined when a flag is the last token (no value follows)', () => {
    const ctx = makeContext(['--name']);
    expect(ctx.flag('--name')).toBeUndefined();
  });
});

describe('renderHelp', () => {
  it('lists every command with its usage hint and summary', () => {
    const help = renderHelp(fixtureCommands({ calls: [] }));
    expect(help).toContain('shreni greet');
    expect(help).toContain('--name <n>');
    expect(help).toContain('say hi');
    expect(help).toContain('shreni boom');
    expect(help).toContain('async ok');
  });
});

describe('dispatch', () => {
  it('resolves a command and passes parsed flags to its run', async () => {
    const spy = { calls: [] as unknown[] };
    const code = await dispatch(['greet', '--name', 'grace'], fixtureCommands(spy));
    expect(code).toBe(0);
    expect(spy.calls).toEqual(['grace']);
  });

  it('awaits async commands', async () => {
    const spy = { calls: [] as unknown[] };
    const code = await dispatch(['wait'], fixtureCommands(spy));
    expect(code).toBe(0);
    expect(spy.calls).toEqual(['waited']);
  });

  it('returns exit code 1 and prints the message when a command throws', async () => {
    const code = await dispatch(['boom'], fixtureCommands({ calls: [] }));
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('kaboom');
  });

  it('returns exit code 1 and prints help to stderr for an unknown command', async () => {
    const code = await dispatch(['nope'], fixtureCommands({ calls: [] }));
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('Unknown command: nope');
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('shreni greet'))).toBe(true);
  });

  it('treats a missing command as unknown (code 1)', async () => {
    const code = await dispatch([], fixtureCommands({ calls: [] }));
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('Unknown command: (none)');
  });

  it('prints generated help to stdout with exit code 0 for help/--help/-h', async () => {
    for (const token of ['help', '--help', '-h']) {
      logSpy.mockClear();
      const code = await dispatch([token], fixtureCommands({ calls: [] }));
      expect(code).toBe(0);
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Usage: shreni'))).toBe(true);
    }
  });
});

describe('real command registry', () => {
  it('every command appears in generated help', async () => {
    const { COMMANDS } = await import('./commands.js');
    const help = renderHelp(COMMANDS);
    for (const c of COMMANDS) {
      expect(help).toContain(`shreni ${c.name}`);
    }
    // The `help` command must itself be listed and dispatchable.
    expect(COMMANDS.some(c => c.name === 'help')).toBe(true);
  });
});