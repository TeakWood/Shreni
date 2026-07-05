export type Provider = 'anthropic' | 'gemini' | 'openai';

export interface AgentRunnerOpts {
  provider: Provider;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  agentName: 'silpi' | 'viharapala' | 'parikshaka';
  kshetraId: string;
  beadId: string;
  model: string;
  jsonSchema: Record<string, unknown>;
  // Tool names the agent must never be given (e.g. Write/Edit for a read-only
  // analysis agent). Hard-enforced by adapters with a deny list (claude); other
  // adapters fall back to the prompt-level boundary.
  disallowedTools?: string[];
  // Cancellation handle for in-process self-heal. When the
  // worker aborts a hung run, the dispatcher SIGKILLs the provider subprocess and
  // rejects with AgentAbortedError; the retry loop also stops honoring transient
  // backoff. Absent for normal runs, which never cancel.
  signal?: AbortSignal;
}

// Per-run token accounting recovered from a provider's output stream (the
// stream JSON already carries it — it was parsed and discarded before this seam).
// Absent when the provider surfaced no usage (e.g. gemini's json mode today).
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentRunResult {
  structuredOutput: unknown;
  resultText: string | null;
  toolCallCount: number;
  usage?: TokenUsage;
}

// How a provider's CLI should be spawned. cwd/stdio are handled by the dispatcher.
export interface SpawnSpec {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
}

// Adapters emit through these callbacks so they never depend on the activity log.
export interface AdapterEmit {
  text(text: string): void;
  toolCall(tool: string, detail: string): void;
}

// A per-run parser. The dispatcher feeds stdout lines in, then calls finalize
// once the process closes. finalize MUST throw on agent/transport error so the
// dispatcher's retry logic can decide whether to retry.
export interface StreamParser {
  onLine(line: string): void;
  finalize(exitCode: number | null, stderrTail: string): AgentRunResult;
}

export interface ProviderAdapter {
  readonly name: Provider;
  buildSpawn(opts: AgentRunnerOpts): SpawnSpec;
  createParser(opts: AgentRunnerOpts, emit: AdapterEmit): StreamParser;
}

// Shared: let users point an adapter at a specific binary (e.g. a downloaded
// CLI not on PATH) via an env override, falling back to the PATH name.
export function resolveBin(envVar: string, defaultBin: string): string {
  const override = process.env[envVar];
  return override && override.trim() ? override.trim() : defaultBin;
}

// Shared: trim a tool input down to one salient field for the activity log.
export function toolDetail(name: string, input: Record<string, unknown>): string {
  let raw: string;
  if (name === 'Bash' || name === 'shell' || name === 'run_command') raw = String(input['command'] ?? input['cmd'] ?? '');
  else if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit')
    raw = String(input['file_path'] ?? input['path'] ?? '');
  else if (name === 'Agent') raw = String(input['description'] ?? '');
  else raw = String(Object.values(input)[0] ?? '');
  return raw.replace(/\n/g, ' ').slice(0, 120);
}

// Shared: extract the last top-level JSON object from free text. Used by
// providers that have no structured-output flag (the agent emits JSON as its
// final message and we recover it here).
export function extractLastJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  const candidates: string[] = [];
  if (fenced) {
    for (const f of fenced) candidates.push(f.replace(/```(?:json)?/i, '').replace(/```$/, '').trim());
  }
  // Also scan for the last balanced { ... } span.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1));
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // try the next candidate
    }
  }
  return null;
}
