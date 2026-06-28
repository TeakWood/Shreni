import { spawn } from 'child_process';
import { emit } from '../sthapathi/activity-log.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toolDetail(name: string, input: Record<string, unknown>): string {
  let raw: string;
  if (name === 'Bash') raw = String(input['command'] ?? '');
  else if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit')
    raw = String(input['file_path'] ?? '');
  else if (name === 'Agent') raw = String(input['description'] ?? '');
  else raw = String(Object.values(input)[0] ?? '');
  return raw.replace(/\n/g, ' ').slice(0, 120);
}

export interface AgentRunnerOpts {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  agentName: 'silpi' | 'viharapala' | 'parikshaka';
  kshetraId: string;
  beadId: string;
  model: string;
  jsonSchema: Record<string, unknown>;
}

export interface AgentRunResult {
  structuredOutput: unknown;
  resultText: string | null;
  toolCallCount: number;
}

export async function runClaudeAgent(opts: AgentRunnerOpts): Promise<AgentRunResult> {
  let lastErr = new Error(`${opts.agentName}: no attempt made`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runAttempt(opts);
    } catch (err) {
      lastErr = err as Error;
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
        await sleep(waitMs);
      } else {
        break;
      }
    }
  }

  throw lastErr;
}

function runAttempt(opts: AgentRunnerOpts): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--system-prompt', opts.systemPrompt,
      '--no-session-persistence',
      '--setting-sources', '',
      '--model', opts.model,
      '--json-schema', JSON.stringify(opts.jsonSchema),
      opts.userPrompt,
    ];

    const proc = spawn('claude', args, {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let resultMsg: { result: string | null; structured_output: unknown; is_error: boolean } | null = null;
    let toolCallCount = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line) as Record<string, unknown>);
        } catch { /* skip malformed lines */ }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    function handleMessage(msg: Record<string, unknown>): void {
      const type = msg['type'] as string;

      if (type === 'assistant') {
        const message = (msg['message'] ?? {}) as Record<string, unknown>;
        const content = (message['content'] as Array<Record<string, unknown>>) ?? [];
        for (const block of content) {
          if (block['type'] === 'text') {
            const text = block['text'] as string;
            if (text.trim()) {
              const firstLine = (text.split('\n').find(l => l.trim()) ?? text).slice(0, 120);
              emit({
                type: 'agent_text',
                kshetra: opts.kshetraId,
                beadId: opts.beadId,
                agent: opts.agentName,
                text: firstLine,
              });
            }
          } else if (block['type'] === 'tool_use') {
            toolCallCount++;
            const name = block['name'] as string;
            const input = (block['input'] ?? {}) as Record<string, unknown>;
            emit({
              type: 'agent_tool_call',
              kshetra: opts.kshetraId,
              beadId: opts.beadId,
              agent: opts.agentName,
              tool: name,
              detail: toolDetail(name, input),
            });
          }
        }
      }

      if (type === 'result') {
        resultMsg = {
          result: (msg['result'] as string | null) ?? null,
          structured_output: msg['structured_output'] ?? null,
          is_error: (msg['is_error'] as boolean) ?? false,
        };
      }
    }

    proc.on('error', (err: Error) => {
      reject(new Error(`${opts.agentName}: failed to spawn claude CLI — ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      if (resultMsg) {
        if (resultMsg.is_error) {
          reject(new Error(`${opts.agentName}: agent returned error — ${resultMsg.result ?? '(no message)'}`));
          return;
        }
        resolve({
          structuredOutput: resultMsg.structured_output,
          resultText: resultMsg.result,
          toolCallCount,
        });
        return;
      }
      const stderr = stderrBuf.slice(-1000);
      reject(
        new Error(
          `${opts.agentName}: process exited with code ${code ?? '?'} without a result message` +
            (stderr ? ` — stderr: ${stderr}` : ''),
        ),
      );
    });
  });
}
