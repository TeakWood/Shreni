import { describe, it, expect } from 'vitest';
import { getAdapter } from './index.js';
import { extractLastJsonObject, toolDetail } from './types.js';
import { claudeAdapter } from './claude.js';
import { geminiAdapter } from './gemini.js';
import { codexAdapter } from './codex.js';
import type { AgentRunnerOpts, AdapterEmit } from './types.js';

const BASE_OPTS: AgentRunnerOpts = {
  provider: 'anthropic',
  systemPrompt: 'SYSTEM',
  userPrompt: 'USER',
  cwd: '/repo',
  agentName: 'silpi',
  kshetraId: 'sishya',
  beadId: 'proj-1',
  model: 'claude-sonnet-4-6',
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

function recordingEmit() {
  const texts: string[] = [];
  const tools: { tool: string; detail: string }[] = [];
  const emit: AdapterEmit = {
    text: (t) => texts.push(t),
    toolCall: (tool, detail) => tools.push({ tool, detail }),
  };
  return { emit, texts, tools };
}

// ── getAdapter registry ────────────────────────────────────────────────────────

describe('getAdapter', () => {
  it('maps anthropic -> claude adapter', () => {
    expect(getAdapter('anthropic').name).toBe('anthropic');
  });
  it('maps gemini -> gemini adapter', () => {
    expect(getAdapter('gemini').name).toBe('gemini');
  });
  it('maps openai -> codex adapter', () => {
    expect(getAdapter('openai').name).toBe('openai');
  });
  it('throws on unknown provider', () => {
    // @ts-expect-error testing runtime guard with bad input
    expect(() => getAdapter('bogus')).toThrow('Unknown agent provider');
  });
});

// ── extractLastJsonObject ──────────────────────────────────────────────────────

describe('extractLastJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractLastJsonObject('{"ok":true}')).toEqual({ ok: true });
  });
  it('extracts JSON from a fenced code block', () => {
    expect(extractLastJsonObject('blah\n```json\n{"ok":1}\n```\nthanks')).toEqual({ ok: 1 });
  });
  it('takes the last balanced object when several are present', () => {
    expect(extractLastJsonObject('{"a":1} noise {"b":2}')).toEqual({ b: 2 });
  });
  it('handles nested objects', () => {
    expect(extractLastJsonObject('x {"a":{"b":2}} y')).toEqual({ a: { b: 2 } });
  });
  it('returns null when there is no JSON', () => {
    expect(extractLastJsonObject('no json here')).toBeNull();
  });
});

// ── toolDetail ─────────────────────────────────────────────────────────────────

describe('toolDetail', () => {
  it('uses command for Bash/shell', () => {
    expect(toolDetail('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(toolDetail('shell', { cmd: 'pwd' })).toBe('pwd');
  });
  it('uses file_path/path for file tools', () => {
    expect(toolDetail('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(toolDetail('Write', { path: '/c.ts' })).toBe('/c.ts');
  });
  it('truncates long details and strips newlines', () => {
    const out = toolDetail('Bash', { command: 'a\nb'.padEnd(200, 'x') });
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

// ── claude adapter ─────────────────────────────────────────────────────────────

describe('claudeAdapter.buildSpawn', () => {
  it('spawns the claude CLI in print stream-json mode with bypass perms', () => {
    const spec = claudeAdapter.buildSpawn(BASE_OPTS);
    expect(spec.bin).toBe('claude');
    expect(spec.args).toContain('-p');
    expect(spec.args).toContain('stream-json');
    // stream-json under --print is rejected without --verbose.
    expect(spec.args).toContain('--verbose');
    expect(spec.args).toContain('bypassPermissions');
    expect(spec.args).toContain('SYSTEM');
    expect(spec.args[spec.args.length - 1]).toBe('USER');
    expect(spec.args).toContain(JSON.stringify(BASE_OPTS.jsonSchema));
  });
});

describe('claudeAdapter parser', () => {
  it('emits text + tool calls and returns structured_output from the result message', () => {
    const { emit, texts, tools } = recordingEmit();
    const parser = claudeAdapter.createParser(BASE_OPTS, emit);
    parser.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }));
    parser.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] } }));
    parser.onLine(JSON.stringify({ type: 'result', is_error: false, result: 'done', structured_output: { ok: true } }));
    const res = parser.finalize(0, '');
    expect(res.structuredOutput).toEqual({ ok: true });
    expect(res.toolCallCount).toBe(1);
    expect(texts).toContain('working on it');
    expect(tools).toEqual([{ tool: 'Bash', detail: 'pnpm test' }]);
  });

  it('throws when the result message reports an error', () => {
    const { emit } = recordingEmit();
    const parser = claudeAdapter.createParser(BASE_OPTS, emit);
    parser.onLine(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }));
    expect(() => parser.finalize(1, '')).toThrow('agent returned error');
  });

  it('throws when no result message arrives', () => {
    const { emit } = recordingEmit();
    const parser = claudeAdapter.createParser(BASE_OPTS, emit);
    expect(() => parser.finalize(1, 'stderr tail')).toThrow('without a result message');
  });
});

// ── gemini adapter ─────────────────────────────────────────────────────────────

describe('geminiAdapter', () => {
  it('folds the system prompt into the -p prompt and runs json yolo mode', () => {
    const spec = geminiAdapter.buildSpawn({ ...BASE_OPTS, provider: 'gemini' });
    expect(spec.bin).toBe('gemini');
    expect(spec.args).toContain('-y');
    expect(spec.args).toContain('json');
    // headless mode requires -p <prompt> (a bare positional goes interactive)
    const pIdx = spec.args.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    const prompt = spec.args[pIdx + 1];
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('USER');
  });

  it('recovers structured output from the json wrapper response field', () => {
    const { emit } = recordingEmit();
    const parser = geminiAdapter.createParser({ ...BASE_OPTS, provider: 'gemini' }, emit);
    parser.onLine(JSON.stringify({ session_id: 'x', response: 'here is the result {"ok":true}', stats: {} }));
    const res = parser.finalize(0, '');
    expect(res.structuredOutput).toEqual({ ok: true });
  });

  it('surfaces a gemini wrapper error so the dispatcher can retry', () => {
    const { emit } = recordingEmit();
    const parser = geminiAdapter.createParser({ ...BASE_OPTS, provider: 'gemini' }, emit);
    parser.onLine(JSON.stringify({ session_id: 'x', error: { type: 'Error', message: 'rate limit exceeded', code: 429 } }));
    expect(() => parser.finalize(1, '')).toThrow('rate limit exceeded');
  });

  it('throws on non-zero exit with no parseable JSON', () => {
    const { emit } = recordingEmit();
    const parser = geminiAdapter.createParser({ ...BASE_OPTS, provider: 'gemini' }, emit);
    parser.onLine('total failure, no json');
    expect(() => parser.finalize(1, 'err')).toThrow('no parseable JSON');
  });
});

// ── codex adapter ──────────────────────────────────────────────────────────────

describe('codexAdapter', () => {
  it('runs exec in json full-auto mode with the model', () => {
    const spec = codexAdapter.buildSpawn({ ...BASE_OPTS, provider: 'openai', model: 'gpt-5' });
    expect(spec.bin).toBe('codex');
    expect(spec.args).toContain('exec');
    expect(spec.args).toContain('--json');
    expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spec.args).toContain('gpt-5');
  });

  it('captures agent_message text and recovers JSON from the last message', () => {
    const { emit, texts } = recordingEmit();
    const parser = codexAdapter.createParser({ ...BASE_OPTS, provider: 'openai' }, emit);
    parser.onLine(JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
    parser.onLine(JSON.stringify({ type: 'turn.started' }));
    parser.onLine(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'final {"ok":true}' } }));
    parser.onLine(JSON.stringify({ type: 'turn.completed', usage: {} }));
    const res = parser.finalize(0, '');
    expect(res.structuredOutput).toEqual({ ok: true });
    expect(texts.length).toBeGreaterThan(0);
  });

  it('counts command_execution events once (on item.started)', () => {
    const { emit, tools } = recordingEmit();
    const parser = codexAdapter.createParser({ ...BASE_OPTS, provider: 'openai' }, emit);
    parser.onLine(JSON.stringify({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: '/bin/zsh -lc "pnpm build"', status: 'in_progress' } }));
    parser.onLine(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: '/bin/zsh -lc "pnpm build"', exit_code: 0, status: 'completed' } }));
    parser.onLine(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"ok":true}' } }));
    parser.finalize(0, '');
    expect(tools.length).toBe(1);
    expect(tools[0].tool).toBe('shell');
    expect(tools[0].detail).toContain('pnpm build');
  });

  it('throws on a top-level error event (so the dispatcher can retry)', () => {
    const { emit } = recordingEmit();
    const parser = codexAdapter.createParser({ ...BASE_OPTS, provider: 'openai' }, emit);
    parser.onLine(JSON.stringify({ type: 'error', message: 'rate limit exceeded' }));
    expect(() => parser.finalize(1, '')).toThrow('rate limit exceeded');
  });

  it('throws on turn.failed with the nested error message', () => {
    const { emit } = recordingEmit();
    const parser = codexAdapter.createParser({ ...BASE_OPTS, provider: 'openai' }, emit);
    parser.onLine(JSON.stringify({ type: 'turn.failed', error: { message: 'model not supported' } }));
    expect(() => parser.finalize(1, '')).toThrow('model not supported');
  });
});

describe('resolveBin override', () => {
  it('honours SHRENI_CODEX_BIN when set', () => {
    const prev = process.env.SHRENI_CODEX_BIN;
    process.env.SHRENI_CODEX_BIN = '/custom/path/codex';
    try {
      const spec = codexAdapter.buildSpawn({ ...BASE_OPTS, provider: 'openai' });
      expect(spec.bin).toBe('/custom/path/codex');
    } finally {
      if (prev === undefined) delete process.env.SHRENI_CODEX_BIN;
      else process.env.SHRENI_CODEX_BIN = prev;
    }
  });
});
