import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { projectSlug, transcriptPath, readSessionUsage } from './usage.js';

// Build a Claude Code transcript fixture on disk under a fake projects root, then
// point the (injectable) root at it.
let root: string;
const CWD = '/Users/x/projects/Shreni';
const SESSION = 'abc-123';

function assistant(usage: Record<string, number>, toolCalls = 0) {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: 'hi' }];
  for (let i = 0; i < toolCalls; i++) content.push({ type: 'tool_use', name: 'Bash', input: {} });
  return JSON.stringify({ type: 'assistant', message: { usage, content } });
}

function writeTranscript(lines: string[]): void {
  const path = transcriptPath(CWD, SESSION, root);
  mkdirSync(join(root, projectSlug(CWD)), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  root = join(tmpdir(), `shreni-transcript-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('projectSlug', () => {
  it('slugifies a plain project path (/ -> -)', () => {
    expect(projectSlug('/Users/x/projects/Shreni')).toBe('-Users-x-projects-Shreni');
  });

  it('slugifies dots too (a worktree under a dotdir)', () => {
    expect(projectSlug('/Users/x/.shreni-worktrees/y')).toBe('-Users-x--shreni-worktrees-y');
  });

  it('preserves hyphens, digits, and case', () => {
    expect(projectSlug('/Users/x/projects/eslint-shreni-20260809T045838'))
      .toBe('-Users-x-projects-eslint-shreni-20260809T045838');
  });
});

describe('transcriptPath', () => {
  it('derives <root>/<slug>/<sessionId>.jsonl from cwd + session id', () => {
    expect(transcriptPath(CWD, SESSION, '/ROOT'))
      .toBe(join('/ROOT', '-Users-x-projects-Shreni', 'abc-123.jsonl'));
  });
});

describe('readSessionUsage', () => {
  it('sums per-message usage and tool_use blocks from a fixture transcript', () => {
    writeTranscript([
      assistant({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, 2),
      JSON.stringify({ type: 'user', message: { content: 'ignored' } }),
      assistant({ input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, 1),
    ]);
    const usage = readSessionUsage(CWD, SESSION, root);
    expect(usage).toEqual({
      inputTokens: 13, outputTokens: 12, cacheReadTokens: 150, cacheCreationTokens: 20, toolCallCount: 3,
    });
  });

  it('returns zeros (no throw) when the transcript is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage = readSessionUsage(CWD, 'no-such-session', root);
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips malformed lines and non-assistant lines', () => {
    writeTranscript([
      '{ not json',
      JSON.stringify({ type: 'system', subtype: 'init' }),
      assistant({ input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 1),
      '   ',
    ]);
    const usage = readSessionUsage(CWD, SESSION, root);
    expect(usage).toEqual({
      inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 1,
    });
  });

  it('tolerates an assistant line with no usage block or non-array content', () => {
    writeTranscript([
      JSON.stringify({ type: 'assistant', message: { content: 'not-an-array' } }),
      JSON.stringify({ type: 'assistant', message: {} }),
      assistant({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 0),
    ]);
    const usage = readSessionUsage(CWD, SESSION, root);
    expect(usage.inputTokens).toBe(1);
    expect(usage.toolCallCount).toBe(0);
  });

  it('coerces non-numeric usage fields to 0', () => {
    writeTranscript([
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 'lots', output_tokens: 5 }, content: [] } }),
    ]);
    const usage = readSessionUsage(CWD, SESSION, root);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(5);
  });
});
