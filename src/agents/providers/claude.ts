import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser, TokenUsage } from './types.js';
import { resolveBin, toolDetail } from './types.js';

// The `result` message's usage block. Anthropic reports cache tokens as separate
// creation/read counters; input_tokens excludes the cached reads.
function parseClaudeUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: n(u['input_tokens']),
    outputTokens: n(u['output_tokens']),
    cacheReadTokens: n(u['cache_read_input_tokens']),
    cacheCreationTokens: n(u['cache_creation_input_tokens']),
  };
}

// Anthropic — the `claude` CLI in print mode with stream-json output. This is
// the reference adapter: validated against `claude --help`.
//
// Native execution (the agent-execution design §3.1): the CLI loads the Kshetra's own
// project config — `--setting-sources project` pulls in `.claude/` (skills,
// rules, subagents, MCP) and `CLAUDE.md`, and `--append-system-prompt` layers
// Shreni's dynamic per-run prompt ON TOP of Claude Code's native scaffolding
// instead of replacing it. Shreni no longer reads-and-injects the instruction
// file or repo skills; the injection flip (dispatch.ts) drops that content so it
// is not double-loaded.
export const claudeAdapter: ProviderAdapter = {
  name: 'anthropic',

  buildSpawn(opts: AgentRunnerOpts) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      // --verbose is mandatory when combining --print with stream-json output;
      // the claude CLI rejects the pair otherwise and exits 1 with no result.
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      // Layer Shreni's prompt on top of the repo's native config (see header).
      '--append-system-prompt', opts.systemPrompt,
      '--no-session-persistence',
      '--setting-sources', 'project',
      '--model', opts.model,
      '--json-schema', JSON.stringify(opts.jsonSchema),
    ];

    // Hard tool block (e.g. read-only Parikshaka): bypassPermissions grants every
    // tool, so a deny list is the only way to keep the agent from writing files.
    // Comma-separated; placed before the positional prompt.
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      args.push('--disallowedTools', opts.disallowedTools.join(','));
    }

    args.push(opts.userPrompt);

    return {
      bin: resolveBin('SHRENI_CLAUDE_BIN', 'claude'),
      args,
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    };
  },

  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser {
    let resultMsg: { result: string | null; structured_output: unknown; is_error: boolean; usage?: TokenUsage } | null = null;
    let toolCallCount = 0;

    return {
      onLine(line: string): void {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = msg['type'] as string;

        if (type === 'assistant') {
          const message = (msg['message'] ?? {}) as Record<string, unknown>;
          const content = (message['content'] as Array<Record<string, unknown>>) ?? [];
          for (const block of content) {
            if (block['type'] === 'text') {
              const text = block['text'] as string;
              if (text.trim()) emit.text((text.split('\n').find(l => l.trim()) ?? text).slice(0, 120));
            } else if (block['type'] === 'tool_use') {
              toolCallCount++;
              const name = block['name'] as string;
              const input = (block['input'] ?? {}) as Record<string, unknown>;
              emit.toolCall(name, toolDetail(name, input));
            }
          }
        }

        if (type === 'result') {
          resultMsg = {
            result: (msg['result'] as string | null) ?? null,
            structured_output: msg['structured_output'] ?? null,
            is_error: (msg['is_error'] as boolean) ?? false,
            usage: parseClaudeUsage(msg['usage']),
          };
        }
      },

      finalize(exitCode: number | null, stderrTail: string) {
        if (resultMsg) {
          if (resultMsg.is_error) {
            throw new Error(`${opts.agentName}: agent returned error — ${resultMsg.result ?? '(no message)'}`);
          }
          return {
            structuredOutput: resultMsg.structured_output,
            resultText: resultMsg.result,
            toolCallCount,
            usage: resultMsg.usage,
          };
        }
        throw new Error(
          `${opts.agentName}: process exited with code ${exitCode ?? '?'} without a result message` +
            (stderrTail ? ` — stderr: ${stderrTail}` : ''),
        );
      },
    };
  },
};
