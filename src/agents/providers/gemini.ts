import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser } from './types.js';
import { extractLastJsonObject } from './types.js';

// Google — the `gemini` CLI in non-interactive mode.
//   gemini -m <model> -y -o json "<prompt>"
// Notes / best-effort caveats (gemini CLI not installed in this env; flags from
// the published CLI docs, verify with `gemini --help` before relying on it):
//   * No `--system-prompt` flag, so the system prompt is folded into the prompt.
//   * `-y` (--yolo) auto-approves tool actions (Bash/file edits).
//   * `-o json` buffers a single JSON wrapper { response, stats } at the end
//     rather than streaming tool calls, so per-tool activity is not surfaced;
//     we emit a single completion line instead.
//   * No structured-output flag — the model is told (via the shared agent
//     system prompts) to emit JSON only, which we recover from `response`.
export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',

  buildSpawn(opts: AgentRunnerOpts) {
    const prompt = `${opts.systemPrompt}\n\n=== TASK ===\n${opts.userPrompt}`;
    return {
      bin: 'gemini',
      args: ['-m', opts.model, '-y', '-o', 'json', prompt],
    };
  },

  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser {
    let buf = '';

    return {
      onLine(line: string): void {
        buf += line + '\n';
      },

      finalize(exitCode: number | null, stderrTail: string) {
        const wrapper = extractLastJsonObject(buf) as { response?: unknown } | null;
        // Gemini's json mode wraps the answer under `response`; if the wrapper is
        // absent, treat the whole buffer as the response text.
        const responseText =
          wrapper && typeof wrapper.response === 'string' ? wrapper.response : buf;

        const structuredOutput = extractLastJsonObject(responseText);

        if (structuredOutput == null && exitCode !== 0) {
          throw new Error(
            `${opts.agentName}: gemini exited with code ${exitCode ?? '?'} and no parseable JSON` +
              (stderrTail ? ` — stderr: ${stderrTail}` : ''),
          );
        }

        emit.text('[gemini run complete]');
        return {
          structuredOutput,
          resultText: typeof responseText === 'string' ? responseText : null,
          toolCallCount: 0,
        };
      },
    };
  },
};
