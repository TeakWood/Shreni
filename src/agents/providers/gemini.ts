import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser } from './types.js';
import { extractLastJsonObject } from './types.js';

// Google — the `gemini` CLI in non-interactive (headless) mode.
//   gemini -m <model> -y -o json -p "<prompt>"
// Verified against `gemini --help` (CLI installed locally):
//   * `-p/--prompt <text>` is REQUIRED for headless mode; a bare positional
//     query launches interactive mode instead.
//   * `-y` (--yolo) auto-approves all tool actions (Bash/file edits).
//   * No `--system-prompt` flag, so the system prompt is folded into `-p`.
//   * `-o json` returns a single wrapper object at the end:
//       success -> { session_id, response: "<text>", stats: {...} }
//       error   -> { session_id, error: { type, message, code } }
//     We surface `error.message` (so the dispatcher can retry transients) and
//     recover the structured output JSON from `response`.
//   * `-o stream-json` also exists and would give richer per-tool streaming;
//     left as a future enhancement (its event shape isn't pinned down here).
export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',

  buildSpawn(opts: AgentRunnerOpts) {
    const prompt = `${opts.systemPrompt}\n\n=== TASK ===\n${opts.userPrompt}`;
    return {
      bin: 'gemini',
      args: ['-m', opts.model, '-y', '-o', 'json', '-p', prompt],
    };
  },

  createParser(opts: AgentRunnerOpts, _emit: AdapterEmit): StreamParser {
    let buf = '';

    return {
      onLine(line: string): void {
        buf += line + '\n';
      },

      finalize(exitCode: number | null, stderrTail: string) {
        const wrapper = extractLastJsonObject(buf) as
          | { response?: unknown; error?: { message?: unknown } }
          | null;

        // Surface gemini's own error so the dispatcher's transient-retry logic
        // can inspect the message (rate limit / overloaded / etc.).
        if (wrapper && wrapper.error) {
          const message = typeof wrapper.error.message === 'string' ? wrapper.error.message : 'unknown error';
          throw new Error(`${opts.agentName}: gemini error — ${message}`);
        }

        // json mode wraps the answer under `response`; if absent, fall back to
        // the raw buffer.
        const responseText =
          wrapper && typeof wrapper.response === 'string' ? wrapper.response : buf;

        const structuredOutput = extractLastJsonObject(responseText);

        if (structuredOutput == null && exitCode !== 0) {
          throw new Error(
            `${opts.agentName}: gemini exited with code ${exitCode ?? '?'} and no parseable JSON` +
              (stderrTail ? ` — stderr: ${stderrTail}` : ''),
          );
        }

        _emit.text('[gemini run complete]');
        return {
          structuredOutput,
          resultText: typeof responseText === 'string' ? responseText : null,
          toolCallCount: 0,
        };
      },
    };
  },
};
