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
  // Static MCP connection for a headless executor (pmb.8), resolved from
  // kshetra.agents.<role>.mcp by the role caller (resolveExecutorMcp). The claude
  // adapter connects exactly these servers with --mcp-config and injects
  // secretEnv; executors always spawn --strict-mcp-config, so ambient/host MCP
  // never reaches an autonomous agent — their MCP surface is exactly this list.
  // Absent when the role has no static grant (→ zero MCP; off by default). Phase-1
  // is claude-only (ARD Q5); non-claude adapters ignore this field.
  mcp?: {
    configPaths: string[];
    secretEnv: Record<string, string>;
  };
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
  // The model's context-window size for the run, recovered from the provider's
  // per-model usage breakdown (epic 408/A1, part B). It is the denominator
  // peak_context is judged against — compaction only fires near the limit, so a
  // 0-vs-0 compaction result is uninterpretable without knowing how close the run
  // came. Absent when the provider surfaced no unambiguous entry for the main-loop
  // model (a reader treats absent as unknown; it is never guessed).
  contextWindow?: number;
}

export interface AgentRunResult {
  structuredOutput: unknown;
  resultText: string | null;
  toolCallCount: number;
  usage?: TokenUsage;
}

// Thrown by a parser's finalize() on an agent/transport error, carrying any
// token usage the provider surfaced BEFORE it failed (e.g. claude's `result`
// message with `is_error: true` still reports a usage block; codex reports usage
// on `turn.completed` even when a later item errors). The dispatcher records this
// usage against the failed attempt so real spend on errored/discarded runs is
// not lost (Shreni-beads-1tg). `usage` is absent when the provider surfaced no
// counts (no result message, spawn failure, gemini) — those runs are excluded
// from metering because their token cost is genuinely unknown.
export class AgentRunError extends Error {
  constructor(
    message: string,
    public readonly usage?: TokenUsage,
    public readonly toolCallCount = 0,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
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
  // Per-MODEL-CALL context usage (epic 408/A1). OPTIONAL so codex.ts / gemini.ts
  // compile unchanged as no-ops — only the claude adapter populates it today. The
  // adapter is responsible for calling this exactly once per distinct model call
  // (deduping the CLI's per-content-block events on messageId); the runner turns
  // each call into a turn_usage event, maintaining the 0-based turnIndex. Only the
  // input-side counters are trusted per call (output_tokens on intermediate
  // assistant events may be partial); `sidechain` tags a subagent (Task tool) call
  // that lives in a different context window.
  usage?(u: {
    messageId: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    sidechain: boolean;
  }): void;
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
