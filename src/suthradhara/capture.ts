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

import { spawn } from 'child_process';
import type { SpawnSpec } from '../agents/providers/types';

// The turn loop depends on this shape, not on `spawn`, so tests substitute a
// pure function returning canned assistant text.
export type CaptureFn = (spec: SpawnSpec) => Promise<string>;

export class SuthradharaTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuthradharaTurnError';
  }
}

// Run the spawn and resolve with the final assistant text. Rejects if the CLI
// fails to spawn, exits without a `result` message, or returns an error result.
export const captureClaudeTurn: CaptureFn = (spec) =>
  new Promise<string>((resolve, reject) => {
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
      resolve(resultText ?? '');
    });
  });
