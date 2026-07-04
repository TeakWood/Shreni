import type { AgentRunnerOpts, AdapterEmit, ProviderAdapter, StreamParser } from './types.js';
import { extractLastJsonObject, resolveBin } from './types.js';

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
//
// Native execution (the agent-execution design §3.1): `gemini -p` already loads the
// repo's own config — `GEMINI.md` and `.gemini/settings.json` — because we do
// NOT disable it. So Gemini loads its native instruction file for free; Shreni's
// prompt is a prepended append-style preamble to the user task, and the injection
// flip (dispatch.ts) already dropped the repo skills/instruction-file/conventions
// content so it is not double-loaded.
export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',

  buildSpawn(opts: AgentRunnerOpts) {
    const prompt = `${opts.systemPrompt}\n\n=== TASK ===\n${opts.userPrompt}`;

    // Tool restriction (Shreni-beads-g5u). The gemini CLI has no per-tool deny
    // list (`--allowed-tools` is deprecated), so the equivalent of
    // opts.disallowedTools is the approval mode:
    //   - read-only agents (Parikshaka passes Write/Edit here) run under
    //     `--approval-mode plan`, the CLI's read-only mode, which withholds all
    //     edit/write tools — enforcing the boundary the deny list expresses.
    //   - write agents (Silpi, no disallowedTools) run with `-y` (yolo), which
    //     auto-approves every tool action so they can edit files unattended.
    const readOnly = !!opts.disallowedTools && opts.disallowedTools.length > 0;
    const restriction = readOnly ? ['--approval-mode', 'plan'] : ['-y'];

    return {
      bin: resolveBin('SHRENI_GEMINI_BIN', 'gemini'),
      args: ['-m', opts.model, ...restriction, '-o', 'json', '-p', prompt],
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
