import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser, TokenUsage } from './types.js';
import { extractLastJsonObject, resolveBin, toolDetail } from './types.js';

// The `turn.completed` event's usage block. codex reports cached input as a
// single `cached_input_tokens` (a read-side cache); there is no creation counter.
function parseCodexUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: n(u['input_tokens']),
    outputTokens: n(u['output_tokens']),
    cacheReadTokens: n(u['cached_input_tokens']),
    cacheCreationTokens: 0,
  };
}

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
//
// Native execution (the agent-execution design §3.1): `codex exec` already loads the
// repo's own config — `AGENTS.md` and `~/.codex/config.toml` — because we do NOT
// disable it (unlike the old hermetic Claude run). So codex loads its native
// instruction file for free; Shreni's prompt is a prepended append-style
// preamble to the user task, and the injection flip (dispatch.ts) already dropped
// the repo skills/instruction-file/conventions content so it is not double-loaded.
export const codexAdapter: ProviderAdapter = {
  name: 'openai',

  buildSpawn(opts: AgentRunnerOpts) {
    const prompt = `${opts.systemPrompt}\n\n=== TASK ===\n${opts.userPrompt}`;

    // Tool restriction. codex has no per-tool deny list, so
    // the equivalent of opts.disallowedTools is the sandbox mode:
    //   - read-only agents (Parikshaka passes Write/Edit here) run under
    //     `--sandbox read-only`, which blocks file writes/edits and command side
    //     effects while still allowing reads — enforcing the boundary the deny
    //     list expresses.
    //   - write agents (Silpi, no disallowedTools) run with sandbox + approvals
    //     bypassed so they can create/edit files and run commands unattended.
    // (Based on documented `codex exec` flags; codex is not installed on all dev
    // machines, so this path is covered by unit tests rather than a live run.)
    const readOnly = !!opts.disallowedTools && opts.disallowedTools.length > 0;
    const args = ['exec', '--json'];
    if (readOnly) {
      args.push('--sandbox', 'read-only');
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    args.push('--skip-git-repo-check', '-m', opts.model, prompt);

    return {
      bin: resolveBin('SHRENI_CODEX_BIN', 'codex'),
      args,
    };
  },

  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser {
    let lastAssistantText: string | null = null;
    let toolCallCount = 0;
    let errorMessage: string | null = null;
    let usage: TokenUsage | undefined;

    return {
      onLine(line: string): void {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // non-JSON noise (e.g. "Reading additional input from stdin...")
        }

        const type = String(ev['type'] ?? '');

        if (type === 'turn.completed') {
          usage = parseCodexUsage(ev['usage']);
          return;
        }

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
          usage,
        };
      },
    };
  },
};
