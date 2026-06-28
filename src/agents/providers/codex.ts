import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser } from './types.js';
import { extractLastJsonObject, resolveBin, toolDetail } from './types.js';

// OpenAI — the `codex` CLI in non-interactive exec mode.
//   codex exec --json --dangerously-bypass-approvals-and-sandbox \
//              --skip-git-repo-check -m <model> "<prompt>"
// Verified against `codex exec --help` and live JSONL output (CLI installed
// locally). If codex isn't on PATH, set SHRENI_CODEX_BIN to its full path.
//
// Event stream (`--json` prints JSONL); the shapes we rely on:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"type":"command_execution","command":"...","status":"in_progress"}}
//   {"type":"item.completed","item":{"type":"command_execution","command":"...","exit_code":0,"status":"completed"}}
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
//   {"type":"error","message":"..."}                       (top-level failure)
//   {"type":"turn.failed","error":{"message":"..."}}
//   {"type":"item.completed","item":{"type":"error","message":"..."}}
//
// No inline structured-output flag is used (codex has --output-schema <FILE>,
// but we keep parity with the other adapters): the shared agent system prompts
// require a JSON-only final message, recovered from the last agent_message.
export const codexAdapter: ProviderAdapter = {
  name: 'openai',

  buildSpawn(opts: AgentRunnerOpts) {
    const prompt = `${opts.systemPrompt}\n\n=== TASK ===\n${opts.userPrompt}`;
    return {
      bin: resolveBin('SHRENI_CODEX_BIN', 'codex'),
      args: [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '-m', opts.model,
        prompt,
      ],
    };
  },

  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser {
    let lastAssistantText: string | null = null;
    let toolCallCount = 0;
    let errorMessage: string | null = null;

    return {
      onLine(line: string): void {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // non-JSON noise (e.g. "Reading additional input from stdin...")
        }

        const type = String(ev['type'] ?? '');

        if (type === 'error') {
          errorMessage = String(ev['message'] ?? 'unknown error');
          return;
        }
        if (type === 'turn.failed') {
          const err = (ev['error'] ?? {}) as Record<string, unknown>;
          errorMessage = String(err['message'] ?? 'turn failed');
          return;
        }

        if (type === 'item.started' || type === 'item.completed') {
          const item = (ev['item'] ?? {}) as Record<string, unknown>;
          const itemType = String(item['type'] ?? '');

          if (itemType === 'agent_message' && type === 'item.completed') {
            const text = typeof item['text'] === 'string' ? (item['text'] as string) : '';
            if (text.trim()) {
              lastAssistantText = text;
              emit.text((text.split('\n').find(l => l.trim()) ?? text).slice(0, 120));
            }
          } else if (itemType === 'command_execution' && type === 'item.started') {
            // Count once, on start, so started+completed isn't double-counted.
            toolCallCount++;
            emit.toolCall('shell', toolDetail('shell', item));
          } else if (itemType === 'error') {
            errorMessage = String(item['message'] ?? 'item error');
          }
        }
      },

      finalize(exitCode: number | null, stderrTail: string) {
        // Surface codex errors so the dispatcher's transient-retry logic can act
        // on rate-limit / overloaded / 5xx messages.
        if (errorMessage) {
          throw new Error(`${opts.agentName}: codex error — ${errorMessage}`);
        }

        const structuredOutput = extractLastJsonObject(lastAssistantText ?? '');

        if (structuredOutput == null && exitCode !== 0) {
          throw new Error(
            `${opts.agentName}: codex exited with code ${exitCode ?? '?'} and no parseable JSON` +
              (stderrTail ? ` — stderr: ${stderrTail}` : ''),
          );
        }

        return {
          structuredOutput,
          resultText: lastAssistantText,
          toolCallCount,
        };
      },
    };
  },
};
