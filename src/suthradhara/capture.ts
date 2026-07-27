// Spawn-and-capture for one interview turn. session.ts builds the SpawnSpec (the
// read-only `claude -p --output-format stream-json` invocation); this module runs
// it and hands back the model's final assistant text — the string the distiller
// (distill.ts) then splits into the human reply and the state delta.
//
// It is a deliberately thin cousin of the Sthapathi provider dispatcher
// (agents/runner.ts + providers/claude.ts): Suthradhara turns are interactive and
// single-shot, with no activity-log emit, no usage metering, and no
// transient-retry loop (an operator is watching and can just resend). What it
// shares is the stream-json contract — parse each stdout line, keep the final
// `result` message, and treat `is_error` as a thrown failure. Kept injectable
// (the turn loop takes a CaptureFn) so turnloop.test.ts never spawns a process.
//
// GRANT-ON-DEMAND SEAM (bead pmb.3, §DISCOVERY). The turn also surfaces the tools
// the model TRIED to call that the `--allowedTools` whitelist refused this turn.
// The stream-json `result` message reports these in a `permission_denials` array
// (each entry: tool_name / tool_use_id / tool_input), and a denied call does NOT
// error the turn — `is_error` stays false and the model just narrates that it is
// waiting on permission. Suthradhara relies on exactly this so an
// mcp__jira__get_issue the model reaches for is denied → captured here → the turn
// loop can prompt the operator [y / always / N] and re-spawn with the grant
// (pmb.6). We read the authoritative `permission_denials` array rather than
// re-pairing tool_use/tool_result blocks ourselves.

import { spawn } from 'child_process';
import type { SpawnSpec } from '../agents/providers/types';

// A tool the model attempted to call that the turn's allowlist refused. `name` is
// the exact tool identifier (e.g. `mcp__jira__get_issue`) the grant-on-demand
// prompt keys on; `input` is the opaque call arguments (e.g. the issue key), kept
// so pmb.6 can echo what was asked. `toolUseId` correlates the denial to its call.
export interface DeniedTool {
  name: string;
  toolUseId?: string;
  input?: unknown;
}

// What one interview turn yields: the model's final assistant text (which the
// distiller splits into human reply + state delta) plus the tools the allowlist
// denied this turn (empty when none were). The turn loop consumes both.
export interface CaptureResult {
  text: string;
  deniedTools: DeniedTool[];
}

// The turn loop depends on this shape, not on `spawn`, so tests substitute a
// pure function returning a canned CaptureResult.
export type CaptureFn = (spec: SpawnSpec) => Promise<CaptureResult>;

// Fail-safe extraction of the `permission_denials` array from a `result` message.
// Anything that isn't a well-formed entry (non-array, missing/empty tool_name) is
// skipped rather than thrown on — a malformed field must not sink an otherwise
// good turn.
function parseDenials(raw: unknown): DeniedTool[] {
  if (!Array.isArray(raw)) return [];
  const out: DeniedTool[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = e['tool_name'];
    if (typeof name !== 'string' || !name) continue;
    out.push({
      name,
      toolUseId: typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined,
      input: e['tool_input'],
    });
  }
  return out;
}

export class SuthradharaTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuthradharaTurnError';
  }
}

// Run the spawn and resolve with the final assistant text plus any denied tools.
// Rejects if the CLI fails to spawn, exits without a `result` message, or returns
// an error result.
export const captureClaudeTurn: CaptureFn = (spec) =>
  new Promise<CaptureResult>((resolve, reject) => {
    const proc = spawn(spec.bin, spec.args, {
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (spec.stdin !== undefined && proc.stdin) {
      proc.stdin.write(spec.stdin);
      proc.stdin.end();
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let resultText: string | null = null;
    let isError = false;
    let sawResult = false;
    let deniedTools: DeniedTool[] = [];

    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // non-JSON diagnostic line; ignore
      }
      if (msg['type'] === 'result') {
        sawResult = true;
        resultText = (msg['result'] as string | null) ?? null;
        isError = (msg['is_error'] as boolean) ?? false;
        deniedTools = parseDenials(msg['permission_denials']);
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

    proc.on('error', (err: Error) => {
      reject(new SuthradharaTurnError(`failed to spawn ${spec.bin}: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      if (stdoutBuf.trim()) onLine(stdoutBuf);
      if (!sawResult) {
        reject(new SuthradharaTurnError(
          `interview turn exited with code ${code ?? '?'} without a result` +
            (stderrBuf.trim() ? ` — stderr: ${stderrBuf.slice(-500).trim()}` : ''),
        ));
        return;
      }
      if (isError) {
        reject(new SuthradharaTurnError(`interview turn returned an error — ${resultText ?? '(no message)'}`));
        return;
      }
      resolve({ text: resultText ?? '', deniedTools });
    });
  });
