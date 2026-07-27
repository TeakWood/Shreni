import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// captureClaudeTurn drives a real `spawn`, so the fixtures are fed through a fake
// child process: mockSpawn returns an emitter whose stdout we push canned
// stream-json lines onto, then close. The lines mirror what `claude -p
// --output-format stream-json` actually emits (captured from the CLI): an
// assistant tool_use, a permission-denied tool_result, and a final `result`
// message whose `permission_denials` array is the authoritative denial source.
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: mockSpawn }));

import { captureClaudeTurn, type DeniedTool } from './capture';
import type { SpawnSpec } from '../agents/providers/types';

const SPEC: SpawnSpec = { bin: 'claude', args: ['-p'], env: {} };

// A minimal ChildProcess stand-in: an EventEmitter with stdout/stderr emitters
// and an optional stdin sink. Tests emit stdout chunks then a `close`.
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
}

// Run captureClaudeTurn against a scripted transcript. captureClaudeTurn attaches
// its stdout/close listeners synchronously in the Promise executor, so we can
// push data and close the process immediately after the call returns the promise.
function runWith(lines: string[], opts: { code?: number; stderr?: string; chunking?: 'lines' | 'blob' } = {}) {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const promise = captureClaudeTurn(SPEC);
  if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'));
  const payload = lines.join('\n') + '\n';
  if (opts.chunking === 'blob') {
    // One buffer carrying every line — exercises the split/keep-remainder logic.
    proc.stdout.emit('data', Buffer.from(payload, 'utf8'));
  } else {
    for (const line of lines) proc.stdout.emit('data', Buffer.from(line + '\n', 'utf8'));
  }
  proc.emit('close', opts.code ?? 0);
  return promise;
}

// A `result` line with an arbitrary permission_denials value spliced in.
function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', ...fields });
}

const ASSISTANT_TEXT = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: "I'll pull PROJ-123 now." }] },
});

// The model reaches for an ungranted MCP tool; the CLI denies it and reports the
// denial both as an errored tool_result and in the result's permission_denials.
const DENIED_TOOL_USE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_jira01', name: 'mcp__jira__get_issue', input: { issueKey: 'PROJ-123' } }],
  },
});
const DENIED_TOOL_RESULT = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_jira01',
      content: "Claude requested permissions to use mcp__jira__get_issue, but you haven't granted it yet.",
      is_error: true,
    }],
  },
});
const DENIED_RESULT = resultLine({
  result: "I don't have access to Jira granted yet — approve it and I'll pull PROJ-123.",
  permission_denials: [
    { tool_name: 'mcp__jira__get_issue', tool_use_id: 'toolu_jira01', tool_input: { issueKey: 'PROJ-123' } },
  ],
});

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('captureClaudeTurn — denied-tool surfacing (pmb.3)', () => {
  it('returns the reply text AND a structured record naming the denied tool', async () => {
    const res = await runWith([ASSISTANT_TEXT, DENIED_TOOL_USE, DENIED_TOOL_RESULT, DENIED_RESULT]);
    expect(res.text).toBe("I don't have access to Jira granted yet — approve it and I'll pull PROJ-123.");
    expect(res.deniedTools).toEqual<DeniedTool[]>([
      { name: 'mcp__jira__get_issue', toolUseId: 'toolu_jira01', input: { issueKey: 'PROJ-123' } },
    ]);
  });

  it('does NOT error the turn on a denial — is_error stays false, the promise resolves', async () => {
    // A denied tool comes back with is_error:false on the RESULT (only the
    // tool_result block is errored), so the turn must resolve, not reject.
    await expect(runWith([DENIED_TOOL_USE, DENIED_TOOL_RESULT, DENIED_RESULT])).resolves.toBeTruthy();
  });

  it('returns an empty list when the turn denied no tools', async () => {
    const res = await runWith([ASSISTANT_TEXT, resultLine({ result: 'done', permission_denials: [] })]);
    expect(res.deniedTools).toEqual([]);
    expect(res.text).toBe('done');
  });

  it('returns an empty list when the result omits permission_denials entirely (older CLI)', async () => {
    const res = await runWith([resultLine({ result: 'done' })]);
    expect(res.deniedTools).toEqual([]);
  });

  it('surfaces every denied tool when more than one was refused in a turn', async () => {
    const res = await runWith([resultLine({
      permission_denials: [
        { tool_name: 'mcp__jira__get_issue', tool_use_id: 'a', tool_input: { k: 1 } },
        { tool_name: 'mcp__confluence__search', tool_use_id: 'b', tool_input: { q: 'x' } },
      ],
    })]);
    expect(res.deniedTools.map(d => d.name)).toEqual(['mcp__jira__get_issue', 'mcp__confluence__search']);
  });

  it('tolerates a denial entry missing tool_use_id / tool_input', async () => {
    const res = await runWith([resultLine({ permission_denials: [{ tool_name: 'mcp__jira__get_issue' }] })]);
    expect(res.deniedTools).toEqual<DeniedTool[]>([
      { name: 'mcp__jira__get_issue', toolUseId: undefined, input: undefined },
    ]);
  });
});

describe('captureClaudeTurn — fail-safe parsing', () => {
  it('ignores non-JSON diagnostic lines and still returns the result + denials', async () => {
    const res = await runWith([
      'Starting up…',                       // bare diagnostic text
      ASSISTANT_TEXT,
      '{ this is not valid json',            // truncated/garbage line
      DENIED_RESULT,
    ]);
    expect(res.text).toContain('approve it');
    expect(res.deniedTools).toHaveLength(1);
  });

  it('skips malformed permission_denials without throwing', async () => {
    const res = await runWith([resultLine({
      permission_denials: [
        null,                                    // not an object
        'mcp__jira__get_issue',                  // a bare string, not an entry
        { tool_use_id: 'x' },                    // missing tool_name
        { tool_name: '' },                       // empty tool_name
        { tool_name: 'mcp__jira__get_issue', tool_use_id: 'ok' }, // the one good entry
      ],
    })]);
    expect(res.deniedTools).toEqual<DeniedTool[]>([
      { name: 'mcp__jira__get_issue', toolUseId: 'ok', input: undefined },
    ]);
  });

  it('treats a non-array permission_denials as no denials', async () => {
    const res = await runWith([resultLine({ permission_denials: { tool_name: 'x' } })]);
    expect(res.deniedTools).toEqual([]);
  });

  it('parses lines that arrive coalesced in a single stdout chunk', async () => {
    const res = await runWith([ASSISTANT_TEXT, DENIED_TOOL_USE, DENIED_TOOL_RESULT, DENIED_RESULT], { chunking: 'blob' });
    expect(res.deniedTools).toHaveLength(1);
    expect(res.text).toContain('approve it');
  });
});

describe('captureClaudeTurn — error paths preserved', () => {
  it('rejects when the result reports is_error, even if denials are present', async () => {
    const line = resultLine({ is_error: true, result: 'boom', permission_denials: [{ tool_name: 'mcp__x__y' }] });
    await expect(runWith([line])).rejects.toThrow(/returned an error/);
  });

  it('rejects when the process closes without a result message', async () => {
    await expect(runWith([ASSISTANT_TEXT], { code: 1, stderr: 'kaboom' })).rejects.toThrow(/without a result/);
  });

  it('rejects when the process fails to spawn', async () => {
    const proc = new FakeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = captureClaudeTurn(SPEC);
    proc.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toThrow(/failed to spawn/);
  });
});
