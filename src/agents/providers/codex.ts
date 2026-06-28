import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser } from './types.js';
import { extractLastJsonObject, toolDetail } from './types.js';

// OpenAI — the `codex` CLI in non-interactive exec mode.
//   codex exec --json --dangerously-bypass-approvals-and-sandbox -m <model> "<prompt>"
// Notes / best-effort caveats (codex CLI not installed in this env; flags from
// the published CLI docs, verify with `codex exec --help` before relying on it):
//   * `exec` is the non-interactive subcommand; cwd is set by the dispatcher.
//   * `--json` emits JSONL events; shapes vary by version, so parsing is
//     defensive — we surface any assistant text and command/tool events we can
//     recognise and keep the last assistant message as the result text.
//   * Full autonomy flag lets it run shell/file tools without prompting.
//   * No structured-output flag — the model is told (via the shared agent system
//     prompts) to emit JSON only, recovered from the final assistant message.
export const codexAdapter: ProviderAdapter = {
  name: 'openai',

  buildSpawn(opts: AgentRunnerOpts) {
    const prompt = `${opts.systemPrompt}\n\n=== TASK ===\n${opts.userPrompt}`;
    return {
      bin: 'codex',
      args: [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '-m', opts.model,
        prompt,
      ],
    };
  },

  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser {
    let lastAssistantText: string | null = null;
    let toolCallCount = 0;
    let rawBuf = '';

    return {
      onLine(line: string): void {
        rawBuf += line + '\n';
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        // Defensive: codex event shapes differ across versions. Look for an
        // assistant/agent message and for command/tool executions.
        const type = String(ev['type'] ?? ev['kind'] ?? '');
        const item = (ev['item'] ?? ev['msg'] ?? ev) as Record<string, unknown>;

        const role = String(item['role'] ?? '');
        const text =
          typeof item['text'] === 'string' ? (item['text'] as string)
          : typeof item['content'] === 'string' ? (item['content'] as string)
          : typeof ev['text'] === 'string' ? (ev['text'] as string)
          : null;

        if ((role === 'assistant' || type.includes('message') || type.includes('agent')) && text && text.trim()) {
          lastAssistantText = text;
          emit.text((text.split('\n').find(l => l.trim()) ?? text).slice(0, 120));
        }

        const command = item['command'] ?? item['cmd'] ?? ev['command'];
        if (type.includes('command') || type.includes('tool') || type.includes('exec') || command) {
          toolCallCount++;
          const name = String(item['name'] ?? ev['name'] ?? 'shell');
          emit.toolCall(name, toolDetail(name, item));
        }
      },

      finalize(exitCode: number | null, stderrTail: string) {
        const source = lastAssistantText ?? rawBuf;
        const structuredOutput = extractLastJsonObject(source);

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
