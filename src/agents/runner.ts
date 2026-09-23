import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { emit, touchHeartbeat, getCurrentRunId } from '../sthapathi/activity-log.js';
import { nowMs, elapsedMs } from '../sthapathi/timing.js';
import { AgentAbortedError, RunNotPermittedError } from '../sthapathi/errors.js';
import { getUsageMeter, getPolicySource, costFor } from '../ext/index.js';
import type { ModelSelection, UsageRecord } from '../ext/index.js';
import { getAdapter } from './providers/index.js';
import { AgentRunError } from './providers/types.js';
import type { AgentRunnerOpts, AgentRunResult, AdapterEmit, TokenUsage } from './providers/types.js';

// Fingerprint the exact inputs a run was dispatched with, for the run_started
// ledger entry (4a2.2). A stable SHA-256 over the resolved provider/model, the
// agent, both prompts, and the tool/MCP surface — the "manifest" of what the
// agent was asked to do. Same inputs → same hash, so two runs are comparable and
// a run is reproducible; a prompt or model change moves the hash. Field order is
// fixed (JSON.stringify of an object literal preserves insertion order) so the
// digest is deterministic. Cheap: one hash of already-in-memory strings.
function manifestHashFor(opts: AgentRunnerOpts, selection: ModelSelection): string {
  const manifest = JSON.stringify({
    provider: selection.provider,
    model: selection.model,
    agent: opts.agentName,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    disallowedTools: opts.disallowedTools ?? [],
    mcp: opts.mcp?.configPaths ?? [],
  });
  return createHash('sha256').update(manifest).digest('hex');
}

export type { AgentRunnerOpts, AgentRunResult };
export type { Provider } from './providers/types.js';

const TRANSIENT_MARKERS = [
  'overloaded',
  'api error: 429',
  'api error: 500',
  'api error: 502',
  'api error: 503',
  'api error: 504',
  'api error: 529',
  'rate limit',
  'rate_limit',
  'service unavailable',
  'internal server error',
] as const;

const MAX_ATTEMPTS = 4;
// Wait before attempts 2, 3, 4
const RETRY_BACKOFF_MS: [number, number, number] = [10_000, 30_000, 60_000];

function looksTransient(text: string): boolean {
  const lower = text.toLowerCase();
  return TRANSIENT_MARKERS.some(m => lower.includes(m));
}

// Abortable backoff: resolves after ms, or early (still resolves — the caller
// re-checks signal.aborted and stops retrying) the moment the signal aborts, so
// a pending 60s transient backoff never delays a self-heal cancellation.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Dispatcher: picks the provider adapter, spawns its CLI, streams events to the
// activity log, and retries on transient errors. Provider-specific command
// construction and output parsing live in ./providers/*.
export async function runAgent(opts: AgentRunnerOpts): Promise<AgentRunResult> {
  // Selection + go/no-go run ONCE per run (not per attempt), routed through the
  // PolicySource seam (epg.5). The default static policy echoes today's
  // kshetra.yaml choice and always allows, so behavior is unchanged; an optional
  // policy extension may route the model per bead or deny a run.
  const policy = getPolicySource();
  const selection = policy.selectModel({
    kshetra: opts.kshetraId,
    beadId: opts.beadId,
    agent: opts.agentName,
    default: { provider: opts.provider, model: opts.model },
  });
  // Decision-grade (4a2.2): record the model-routing decision at the site it
  // resolves. Under the default static policy this simply echoes kshetra.yaml,
  // but an extension policy may route per bead — the ledger captures which.
  emit({
    type: 'policy_decision',
    kshetra: opts.kshetraId,
    beadId: opts.beadId,
    agent: opts.agentName,
    policy: 'selectModel',
    provider: selection.provider,
    model: selection.model,
  });
  const decision = policy.mayProceed({
    kshetra: opts.kshetraId,
    beadId: opts.beadId,
    agent: opts.agentName,
    provider: selection.provider,
    model: selection.model,
  });
  // Record the go/no-go decision — including a denial, before it throws — so the
  // ledger shows a blocked run and why it was blocked, not just its absence.
  emit({
    type: 'policy_decision',
    kshetra: opts.kshetraId,
    beadId: opts.beadId,
    agent: opts.agentName,
    policy: 'mayProceed',
    allowed: decision.allowed,
    ...(decision.allowed ? {} : { reason: decision.reason }),
  });
  if (!decision.allowed) throw new RunNotPermittedError(opts.agentName, decision.reason);

  // The run is permitted and about to begin. run_started fingerprints the exact
  // inputs (prompts + provider/model/tools) so the run is reproducible and two
  // runs are comparable; the per-token stream lands in activity.jsonl under the
  // same runId. Emitted only after mayProceed allows — a denied run never starts.
  emit({
    type: 'run_started',
    kshetra: opts.kshetraId,
    beadId: opts.beadId,
    agent: opts.agentName,
    provider: selection.provider,
    model: selection.model,
    manifestHash: manifestHashFor(opts, selection),
  });

  // The effective run uses the policy-selected provider/model (identical to
  // opts under the default policy). Retry/backoff/failover stay here.
  const runOpts: AgentRunnerOpts = { ...opts, provider: selection.provider, model: selection.model };
  let lastErr = new Error(`${runOpts.agentName}: no attempt made`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Time the provider subprocess for THIS attempt (spawn → exit), at the site,
    // with a monotonic clock (epic hto / Study A3). Captured on both the ok and
    // error path — a failed session still consumed real time.
    const attemptStart = nowMs();
    try {
      const result = await runAttempt(runOpts);
      reportUsage(runOpts, 'ok', result.usage, result.toolCallCount, elapsedMs(attemptStart));
      return result;
    } catch (err) {
      lastErr = err as Error;
      // Record the tokens a failed attempt spent, when the provider surfaced any
      // (Shreni-beads-1tg). This fires for every failed attempt — including ones
      // that are about to be retried — so discarded-retry spend is captured too.
      // Aborts/spawn failures/no-result exits carry no usage and record nothing.
      if (lastErr instanceof AgentRunError && lastErr.usage) {
        reportUsage(runOpts, 'error', lastErr.usage, lastErr.toolCallCount, elapsedMs(attemptStart));
      }
      // A self-heal abort is terminal — never retry it (the run is being
      // cancelled on purpose so the worker can RECOVER).
      if (lastErr instanceof AgentAbortedError || runOpts.signal?.aborted) throw lastErr;
      const msg = lastErr.message;
      if (looksTransient(msg) && attempt < MAX_ATTEMPTS) {
        const waitMs = RETRY_BACKOFF_MS[attempt - 1];
        emit({
          type: 'agent_text',
          kshetra: runOpts.kshetraId,
          beadId: runOpts.beadId,
          agent: runOpts.agentName,
          text: `[transient error — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${msg.slice(0, 200)}]`,
        });
        await sleep(waitMs, runOpts.signal);
        // The backoff may have been cut short by an abort — re-check before retrying.
        if (runOpts.signal?.aborted) throw new AgentAbortedError();
      } else {
        break;
      }
    }
  }

  throw lastErr;
}

// Back-compat alias — earlier code/tests referred to runClaudeAgent.
export const runClaudeAgent = runAgent;

// Hand a finalized run's token usage to the UsageMeter, keyed to the same
// attempt the activity stream is tagged with (kshetra/beadId/runId/agent).
// `outcome` marks whether the run succeeded or failed — a failed run still spent
// its tokens, so it is metered too (Shreni-beads-1tg). Token fields are 0 when
// the provider surfaced no usage (e.g. gemini). Never let metering crash a run.
function reportUsage(
  opts: AgentRunnerOpts,
  outcome: 'ok' | 'error',
  usage: TokenUsage | undefined,
  toolCallCount: number,
  // Monotonic ms this attempt's provider subprocess ran (epic hto / Study A3).
  durationMs: number,
): void {
  const record: UsageRecord = {
    kshetra: opts.kshetraId,
    beadId: opts.beadId,
    runId: getCurrentRunId(opts.kshetraId),
    agent: opts.agentName,
    provider: opts.provider,
    model: opts.model,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
    toolCallCount,
    outcome,
    // Context-window denominator for the run (epic 408/A1, part B). Optional —
    // absent when the provider surfaced no unambiguous main-loop-model entry; a
    // reader treats absent as unknown, never as 0.
    ...(usage?.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
    // Session duration (epic hto / Study A3). On the record — not only the ledger
    // fold below — so usage.jsonl, the cost/timing feed, carries it too
    // (Shreni-beads-dt7): the ledger entry is a projection of this record and
    // must never hold a field the record lacks.
    durationMs,
  };
  try {
    // usage.jsonl (epic g2k): the full per-run record with the price snapshot.
    // Unchanged by 4a2.5 — the meter still computes cost and appends exactly as
    // before. This is the durable, granular source the ledger entry points AT.
    getUsageMeter().record(record);
  } catch {
    // A metering failure must never fail an otherwise-successful agent run.
  }
  // Fold the same record into the decision ledger as a run_usage SUMMARY (4a2.5):
  // agent/provider/model, the headline token totals, cost, outcome, and the
  // optional contextWindow/durationMs — NOT the full record, and NEVER a field
  // the record (hence usage.jsonl) lacks (dt7; enforced at compile time in
  // ext/types.ts). The cache/tool breakdown stays in usage.jsonl, referenced by
  // the envelope's runId. costFor is the same pure price-table lookup the meter uses,
  // so the ledger's cost matches usage.jsonl exactly. A run with no provider usage
  // (gemini) still emits, with zeroed totals, rather than being dropped. One
  // run_usage per metered finalization, mirroring usage.jsonl 1:1 (a transient-
  // retried run meters each discarded attempt, 1tg, so it emits one per attempt).
  // Guarded like the meter call: a fold failure must never fail an otherwise-
  // successful run (emit() is already sink-isolated; costFor is wrapped too).
  try {
    const { costUsd, priced } = costFor(record);
    emit({
      type: 'run_usage',
      kshetra: opts.kshetraId,
      beadId: opts.beadId,
      agent: opts.agentName,
      provider: opts.provider,
      model: opts.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costUsd,
      priced,
      outcome,
      // Carry the context window into the ledger's run_usage fold (4a2.5) so
      // peak_context/contextWindow can be evaluated at read time. Additive
      // optional field; omitted when unknown.
      ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
      // Session duration for time attribution (epic hto / Study A3) — read off
      // the record so the two shapes carry the same value (dt7).
      durationMs: record.durationMs,
    });
  } catch {
    // A ledger-fold failure must never fail an otherwise-successful agent run.
  }
}

function runAttempt(opts: AgentRunnerOpts): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const adapter = getAdapter(opts.provider);
    const spec = adapter.buildSpawn(opts);

    // Each agent emit also refreshes the worker heartbeat (the watchdog design
    // §3.1): the worker's own interval already keeps liveness fresh, but stamping on
    // emit makes a live-but-chatty agent register promptly for cross-process readers
    // (`shreni status` / Phalaka) between worker ticks.
    // Per-call turn counters (epic 408/A1). The main thread and each sidechain
    // (subagent) are counted separately: mixing a subagent's calls into the main-
    // thread index would fake a sawtooth in the effective-context curve exactly
    // where E1 is trying to detect one. 0-based, per runAttempt (a retried attempt
    // is a fresh stream and starts over).
    let mainTurnIndex = 0;
    let sideTurnIndex = 0;
    const adapterEmit: AdapterEmit = {
      text(text: string) {
        if (!text.trim()) return;
        touchHeartbeat(opts.kshetraId);
        emit({ type: 'agent_text', kshetra: opts.kshetraId, beadId: opts.beadId, agent: opts.agentName, text });
      },
      toolCall(tool: string, detail: string) {
        touchHeartbeat(opts.kshetraId);
        emit({ type: 'agent_tool_call', kshetra: opts.kshetraId, beadId: opts.beadId, agent: opts.agentName, tool, detail });
      },
      usage(u) {
        // opts here is runOpts: provider/model are the policy-resolved selection.
        touchHeartbeat(opts.kshetraId);
        const turnIndex = u.sidechain ? sideTurnIndex++ : mainTurnIndex++;
        emit({
          type: 'turn_usage',
          kshetra: opts.kshetraId,
          beadId: opts.beadId,
          agent: opts.agentName,
          provider: opts.provider,
          model: opts.model,
          turnIndex,
          messageId: u.messageId,
          inputTokens: u.inputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          sidechain: u.sidechain,
        });
      },
      compacted(c) {
        // RECORD-ONLY (epic 408 decision 6): emit and return — no abort/retry/
        // replan. `turnIndex` is the last main-thread turn BEFORE the boundary:
        // mainTurnIndex is the next index to assign, so the last emitted is
        // mainTurnIndex - 1 (clamped at 0 for the degenerate pre-first-turn case).
        touchHeartbeat(opts.kshetraId);
        emit({
          type: 'context_compacted',
          kshetra: opts.kshetraId,
          beadId: opts.beadId,
          agent: opts.agentName,
          provider: opts.provider,
          model: opts.model,
          trigger: c.trigger,
          preTokens: c.preTokens,
          turnIndex: Math.max(0, mainTurnIndex - 1),
        });
      },
    };

    const parser = adapter.createParser(opts, adapterEmit);

    // Cancellation for self-heal: SIGKILL the hung provider
    // subprocess the instant the signal aborts, and reject so the loop unwinds.
    // SIGKILL (not TERM) because the hang is, by definition, unresponsive; the
    // work tree is reconciled by recoverKshetra afterward, so nothing is lost to
    // skipping graceful shutdown. If already aborted, don't even spawn.
    if (opts.signal?.aborted) return reject(new AgentAbortedError());

    const proc = spawn(spec.bin, spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const onAbort = (): void => {
      proc.kill('SIGKILL');
      reject(new AgentAbortedError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('close', () => opts.signal?.removeEventListener('abort', onAbort));

    if (spec.stdin !== undefined && proc.stdin) {
      proc.stdin.write(spec.stdin);
      proc.stdin.end();
    }

    let stdoutBuf = '';
    let stderrBuf = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) parser.onLine(line);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`${opts.agentName}: failed to spawn ${spec.bin} CLI — ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      // Flush any trailing partial line.
      if (stdoutBuf.trim()) parser.onLine(stdoutBuf);
      try {
        resolve(parser.finalize(code, stderrBuf.slice(-1000)));
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}
