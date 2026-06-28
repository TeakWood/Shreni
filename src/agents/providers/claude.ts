import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser } from './types.js';
import { resolveBin, toolDetail } from './types.js';

// Anthropic — the `claude` CLI in print mode with stream-json output. This is
// the reference adapter: validated against `claude --help`.
export const claudeAdapter: ProviderAdapter = {
  name: 'anthropic',

  buildSpawn(opts: AgentRunnerOpts) {
    return {
      bin: resolveBin('SHRENI_CLAUDE_BIN', 'claude'),
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
        '--system-prompt', opts.systemPrompt,
        '--no-session-persistence',
        '--setting-sources', '',
        '--model', opts.model,
        '--json-schema', JSON.stringify(opts.jsonSchema),
        opts.userPrompt,
      ],
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    };
  },

  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser {
    let resultMsg: { result: string | null; structured_output: unknown; is_error: boolean } | null = null;
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
