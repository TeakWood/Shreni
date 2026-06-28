import { spawn } from 'child_process';
import { resolveBin } from '../agents/providers/types.js';

export interface VicharaTurnOpts {
  systemPrompt: string;
  userPrompt: string;
  // Working directory for the turn — the active kshetra repo, so `bd`/`git`
  // auto-discover and Read/Grep are scoped to that project.
  cwd: string;
  model: string;
}

// Read-only allowlist. Vichara is an observer: it may inspect files and run
// read-only `bd`/`git`/shell queries, but never edit or mutate. Anything not
// listed here (Write/Edit, `git commit`/`push`, arbitrary Bash) is denied in
// non-interactive print mode, which keeps the read-only boundary enforced by
// the harness rather than by prompt instructions alone.
export const VICHARA_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  // Read-only bd subcommands only — NOT `Bash(bd:*)`, which would let writes
  // like `bd create`/`bd update`/`bd close` through and break the boundary.
  'Bash(bd list:*)',
  'Bash(bd ready:*)',
  'Bash(bd show:*)',
  'Bash(bd blocked:*)',
  'Bash(bd stats:*)',
  'Bash(bd search:*)',
  'Bash(bd memories:*)',
  'Bash(bd stale:*)',
  'Bash(bd orphans:*)',
  // Read-only git inspection.
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
];

// Build the `claude` CLI argv for a single Vichara chat turn. Mirrors the
// agent provider adapter (print mode + stream-json) but authenticates via the
// CLI's own subscription/OAuth credentials — no ANTHROPIC_API_KEY required —
// and constrains the toolset to the read-only allowlist above.
export function buildVicharaSpawnArgs(opts: VicharaTurnOpts): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    // --verbose is mandatory when combining --print with stream-json output.
    '--verbose',
    '--system-prompt', opts.systemPrompt,
    '--no-session-persistence',
    '--setting-sources', '',
    '--permission-mode', 'default',
    '--allowedTools', VICHARA_ALLOWED_TOOLS.join(' '),
    '--model', opts.model,
    opts.userPrompt,
  ];
}

export interface VicharaTurnEvents {
  text(text: string): void;
  toolUse(name: string, input: unknown): void;
  toolResult(name: string): void;
  error(message: string): void;
  done(): void;
}

// Parses one stream-json line and drives the event callbacks. Exported for
// unit testing the protocol mapping without spawning a process. `toolNames`
// tracks tool_use id -> name so tool_result lines can be labelled. Returns the
// final result text (or throws-equivalent via events.error) on a `result` line.
export function handleStreamLine(
  line: string,
  events: VicharaTurnEvents,
  toolNames: Map<string, string>,
  state: { emittedText: boolean },
): { resultText: string | null; isError: boolean } | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = msg['type'] as string;

  if (type === 'assistant') {
    const message = (msg['message'] ?? {}) as Record<string, unknown>;
    const content = (message['content'] as Array<Record<string, unknown>>) ?? [];
    for (const block of content) {
      if (block['type'] === 'text') {
        const text = block['text'] as string;
        if (text) {
          events.text(text);
          state.emittedText = true;
        }
      } else if (block['type'] === 'tool_use') {
        const id = block['id'] as string;
        const name = block['name'] as string;
        toolNames.set(id, name);
        events.toolUse(name, block['input'] ?? {});
      }
    }
    return null;
  }

  if (type === 'user') {
    const message = (msg['message'] ?? {}) as Record<string, unknown>;
    const content = (message['content'] as Array<Record<string, unknown>>) ?? [];
    for (const block of content) {
      if (block['type'] === 'tool_result') {
        const id = block['tool_use_id'] as string;
        events.toolResult(toolNames.get(id) ?? 'tool');
      }
    }
    return null;
  }

  if (type === 'result') {
    return {
      resultText: (msg['result'] as string | null) ?? null,
      isError: (msg['is_error'] as boolean) ?? false,
    };
  }

  return null;
}

// Spawn the `claude` CLI for one chat turn and stream events back through the
// callbacks. Resolves when the process exits.
export function runVicharaTurn(opts: VicharaTurnOpts, events: VicharaTurnEvents): Promise<void> {
  return new Promise(resolvePromise => {
    const bin = resolveBin('SHRENI_CLAUDE_BIN', 'claude');
    const child = spawn(bin, buildVicharaSpawnArgs(opts), {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const toolNames = new Map<string, string>();
    const state = { emittedText: false };
    let stdoutBuf = '';
    let stderrTail = '';
    let result: { resultText: string | null; isError: boolean } | null = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const r = handleStreamLine(line, events, toolNames, state);
        if (r) result = r;
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('error', err => {
      events.error(`failed to launch claude CLI: ${err.message}`);
      events.done();
      resolvePromise();
    });

    child.on('close', (code: number | null) => {
      if (result) {
        if (result.isError) {
          events.error(result.resultText ?? '(agent returned an error)');
        } else if (!state.emittedText && result.resultText) {
          events.text(result.resultText);
        }
      } else {
        events.error(
          `claude exited with code ${code ?? '?'} without a result` +
            (stderrTail ? ` — ${stderrTail.trim()}` : ''),
        );
      }
      events.done();
      resolvePromise();
    });
  });
}