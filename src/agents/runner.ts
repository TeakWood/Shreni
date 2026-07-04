import { spawn } from 'child_process';
import { emit, touchHeartbeat } from '../sthapathi/activity-log.js';
import { AgentAbortedError } from '../sthapathi/errors.js';
import { getAdapter } from './providers/index.js';
import type { AgentRunnerOpts, AgentRunResult, AdapterEmit } from './providers/types.js';

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
  let lastErr = new Error(`${opts.agentName}: no attempt made`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runAttempt(opts);
    } catch (err) {
      lastErr = err as Error;
      // A self-heal abort is terminal — never retry it (the run is being
      // cancelled on purpose so the worker can RECOVER). See Shreni-beads-se0.
      if (lastErr instanceof AgentAbortedError || opts.signal?.aborted) throw lastErr;
      const msg = lastErr.message;
      if (looksTransient(msg) && attempt < MAX_ATTEMPTS) {
        const waitMs = RETRY_BACKOFF_MS[attempt - 1];
        emit({
          type: 'agent_text',
          kshetra: opts.kshetraId,
          beadId: opts.beadId,
          agent: opts.agentName,
          text: `[transient error — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${msg.slice(0, 200)}]`,
        });
        await sleep(waitMs, opts.signal);
        // The backoff may have been cut short by an abort — re-check before retrying.
        if (opts.signal?.aborted) throw new AgentAbortedError();
      } else {
        break;
      }
    }
  }

  throw lastErr;
}

// Back-compat alias — earlier code/tests referred to runClaudeAgent.
export const runClaudeAgent = runAgent;

function runAttempt(opts: AgentRunnerOpts): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const adapter = getAdapter(opts.provider);
    const spec = adapter.buildSpawn(opts);

    // Each agent emit also refreshes the worker heartbeat (the watchdog design
    // §3.1): the worker's own interval already keeps liveness fresh, but stamping on
    // emit makes a live-but-chatty agent register promptly for cross-process readers
    // (`shreni status` / Phalaka) between worker ticks.
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
    };

    const parser = adapter.createParser(opts, adapterEmit);

    // Cancellation for self-heal (Shreni-beads-se0): SIGKILL the hung provider
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
