import { describe, it, expect, vi } from 'vitest';
import {
  buildVicharaSpawnArgs,
  handleStreamLine,
  VICHARA_ALLOWED_TOOLS,
  type VicharaTurnEvents,
} from './agent';

const TURN = {
  systemPrompt: 'SYS',
  userPrompt: 'what is ready?',
  cwd: '/projects/app',
  model: 'claude-sonnet-4-6',
};

function mockEvents() {
  return {
    text: vi.fn(),
    toolUse: vi.fn(),
    toolResult: vi.fn(),
    error: vi.fn(),
    done: vi.fn(),
  } satisfies VicharaTurnEvents;
}

describe('buildVicharaSpawnArgs', () => {
  it('runs the claude CLI in print + stream-json mode with the prompt last', () => {
    const args = buildVicharaSpawnArgs(TURN);
    expect(args).toContain('-p');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'stream-json',
    ]);
    expect(args[args.length - 1]).toBe('what is ready?');
    // stream-json under --print is rejected without --verbose.
    expect(args).toContain('--verbose');
  });

  it('passes the system prompt and model', () => {
    const args = buildVicharaSpawnArgs(TURN);
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
  });

  it('constrains tools to the read-only allowlist and never allows writes', () => {
    const args = buildVicharaSpawnArgs(TURN);
    const allowed = args[args.indexOf('--allowedTools') + 1];
    expect(allowed).toBe(VICHARA_ALLOWED_TOOLS.join(' '));
    expect(allowed).toContain('Bash(bd ready:*)');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Edit');
    expect(allowed).not.toContain('git push');
  });

  it('never allows mutating bd subcommands through a broad wildcard', () => {
    // A bare Bash(bd:*) would let `bd create`/`bd close`/`bd update` through.
    for (const t of VICHARA_ALLOWED_TOOLS) {
      expect(t).not.toBe('Bash(bd:*)');
      expect(t).not.toContain('bd create');
      expect(t).not.toContain('bd close');
      expect(t).not.toContain('bd update');
    }
  });

  it('does not use bypassPermissions (read-only boundary stays enforced)', () => {
    const args = buildVicharaSpawnArgs(TURN);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
  });
});

describe('handleStreamLine', () => {
  const fresh = () => ({ toolNames: new Map<string, string>(), state: { emittedText: false } });

  it('ignores non-JSON lines', () => {
    const events = mockEvents();
    const { toolNames, state } = fresh();
    expect(handleStreamLine('not json', events, toolNames, state)).toBeNull();
    expect(events.text).not.toHaveBeenCalled();
  });

  it('emits assistant text blocks and marks emittedText', () => {
    const events = mockEvents();
    const { toolNames, state } = fresh();
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    handleStreamLine(line, events, toolNames, state);
    expect(events.text).toHaveBeenCalledWith('hello');
    expect(state.emittedText).toBe(true);
  });

  it('emits tool_use with input and records the id->name mapping', () => {
    const events = mockEvents();
    const { toolNames, state } = fresh();
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bd ready' } }] },
    });
    handleStreamLine(line, events, toolNames, state);
    expect(events.toolUse).toHaveBeenCalledWith('Bash', { command: 'bd ready' });
    expect(toolNames.get('tu_1')).toBe('Bash');
  });

  it('labels tool_result lines from the recorded tool name', () => {
    const events = mockEvents();
    const { toolNames, state } = fresh();
    toolNames.set('tu_1', 'Bash');
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] },
    });
    handleStreamLine(line, events, toolNames, state);
    expect(events.toolResult).toHaveBeenCalledWith('Bash');
  });

  it('returns the result text and error flag on a result line', () => {
    const events = mockEvents();
    const { toolNames, state } = fresh();
    const ok = handleStreamLine(JSON.stringify({ type: 'result', result: 'final', is_error: false }), events, toolNames, state);
    expect(ok).toEqual({ resultText: 'final', isError: false });
    const err = handleStreamLine(JSON.stringify({ type: 'result', result: 'boom', is_error: true }), events, toolNames, state);
    expect(err).toEqual({ resultText: 'boom', isError: true });
  });
});
