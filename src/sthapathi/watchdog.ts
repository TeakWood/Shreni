import { statSync } from 'fs';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Phase } from './index.js';
import { getProgressState, isKshetraManuallyPaused, pauseKshetra, setStuck } from '../kshetra/state.js';
import { heartbeatPath, logPath } from './activity-log.js';
import { notifyOperator } from './errors.js';

// Defaults per the Sthapathi workflow design §4.4 / D1. Made configurable
// per-Kshetra later.
export const STUCK_THRESHOLD_MS = 20 * 60 * 1000; // 20m of no liveness while busy
export const MAX_OUTCOME_REPEAT = 5; // same non-advancing outcome this many times

export interface StuckInput {
  phase: Phase;
  manuallyPaused: boolean;
  // Time since the worker last stamped its liveness heartbeat (the watchdog design
  // §3.1). Decoupled from agent emits so a long silent tool call does not read as
  // hung. null when there is no heartbeat (and no activity log) yet — a fresh worker.
  heartbeatAgeMs: number | null;
  outcomeRepeatCount: number;
  lastOutcome?: string;
  // The worker has nothing to do: the ready queue is empty AND no task is in
  // flight (see runWatchdogOnce). Inactivity here is idle-by-design, not a hang —
  // a stale heartbeat while merely idle must never trip.
  idleNoWork?: boolean;
  thresholds?: { stuckMs?: number; maxRepeat?: number };
}

export interface StuckVerdict {
  stuck: boolean;
  reason?: string;
  remediation?: string;
}

// Human-facing remediation steps for a given stall outcome. Generic fallback
// covers a hung agent / unknown stall.
export function remediationFor(outcome: string | undefined): string {
  const o = outcome ?? '';
  if (o.includes('branch already exists')) {
    return [
      '  1) Delete the stale bead branch, then resume:',
      '       git -C <repo> branch -D <bead-branch>',
      '       shreni resume --kshetra <id>',
      '  2) If it recurs, the worker will RECOVER it on next start (shreni stop/start).',
    ].join('\n');
  }
  if (o.includes('dirty working tree')) {
    return [
      '  1) Inspect, then discard the interrupted changes:',
      '       git -C <repo> status',
      '       git -C <repo> checkout main && git -C <repo> clean -fd',
      '  2) shreni resume --kshetra <id>  (RECOVER also cleans this on restart)',
    ].join('\n');
  }
  if (o.includes('cycle:GIT_FAILED') || o.includes('cycle:BD_FAILED')) {
    return [
      '  1) Read the error in the worker log; fix the underlying git/bd issue.',
      '  2) shreni resume --kshetra <id>',
    ].join('\n');
  }
  if (o.includes('base suite red') || o.includes('health')) {
    return [
      '  1) A [shreni-health] repair bead should be queued — let it run, or',
      '  2) fix the failing tests manually, then shreni resume --kshetra <id>.',
    ].join('\n');
  }
  // One honest clearing verb — ACK — named everywhere (the watchdog design §3.3 /
  // RC3). The latch clears only on an explicit human acknowledgment, exposed two
  // ways that both funnel to resumeKshetra: the CLI, and a deliberate stop/start
  // (RECOVER acknowledges the drift, then clears it).
  return [
    '  1) Inspect the worker log and the active bead for a genuinely hung agent.',
    '  2) ACK to clear the latch and resume — either of:',
    '       shreni resume --kshetra <id>          (CLI ACK)',
    '       shreni stop --kshetra <id> && shreni start --kshetra <id>  (RECOVER acknowledges)',
    '  3) If a specific bead keeps failing, mark it blocked for manual work.',
  ].join('\n');
}

// Pure decision: is the worker stuck? Two independent trip conditions — a fast
// stall loop (same outcome repeated) and a liveness timeout (no activity while
// the worker should be busy). A manually-paused Kshetra is never "stuck" (it is
// already awaiting a human).
export function evaluateStuck(input: StuckInput): StuckVerdict {
  if (input.manuallyPaused) return { stuck: false };

  // Idle by design: an empty ready queue with nothing in flight. "No activity"
  // here means "nothing to do", not "hung" — never trip, so the watchdog never
  // escalates an idle worker to Phalaka. A genuine
  // hang while WORKING/PREPARING, or a repeat-stall with ready work waiting, is
  // not idle (idleNoWork is false there) and still trips below.
  if (input.idleNoWork) return { stuck: false };

  const stuckMs = input.thresholds?.stuckMs ?? STUCK_THRESHOLD_MS;
  const maxRepeat = input.thresholds?.maxRepeat ?? MAX_OUTCOME_REPEAT;

  if (input.outcomeRepeatCount >= maxRepeat) {
    return {
      stuck: true,
      reason: `the same outcome "${input.lastOutcome ?? 'unknown'}" repeated ${input.outcomeRepeatCount}× without forward progress`,
      remediation: remediationFor(input.lastOutcome),
    };
  }

  if (input.phase !== 'IDLE' && input.heartbeatAgeMs !== null && input.heartbeatAgeMs > stuckMs) {
    const mins = Math.round(input.heartbeatAgeMs / 60_000);
    return {
      stuck: true,
      reason: `no worker heartbeat for ${mins}m while phase=${input.phase} — the worker appears hung`,
      remediation: remediationFor(undefined),
    };
  }

  return { stuck: false };
}

// Worker liveness = age of the heartbeat file's mtime (the watchdog design §3.1).
// Falls back to the legacy activity.jsonl mtime only when no heartbeat exists yet, so
// an old worker (or the first tick before the first stamp) degrades gracefully rather
// than reading as a fresh worker that can never trip.
function heartbeatAge(kshetraId: string, now: number): number | null {
  try {
    return now - statSync(heartbeatPath(kshetraId)).mtimeMs;
  } catch {
    // no heartbeat file — fall back to agent-emit liveness (legacy behavior)
  }
  try {
    return now - statSync(logPath(kshetraId)).mtimeMs;
  } catch {
    return null;
  }
}

// Evaluate once and, on a fresh trip, escalate: set the stuck banner (Phalaka),
// pause for manual resume, and push an operator notification with remediation.
// Idempotent — does not re-notify while already flagged stuck.
export async function runWatchdogOnce(
  kshetra: KshetraConfig,
  getPhase: () => Phase,
  now: number = Date.now(),
  opts?: { hasReadyWork?: () => boolean | Promise<boolean> },
): Promise<StuckVerdict> {
  const progress = getProgressState(kshetra);
  if (progress.stuck) return { stuck: true, reason: progress.stuck.reason };

  const phase = getPhase();

  // Distinguish "idle because there's nothing to do" from "hung". Only IDLE and
  // SELECTING can be idle-by-design; PREPARING/WORKING always have a task in
  // flight, so we skip the ready-queue probe (and its bd call) on busy ticks.
  // When the probe reports an empty queue, inactivity is expected — not stuck.
  let idleNoWork = false;
  if ((phase === 'IDLE' || phase === 'SELECTING') && opts?.hasReadyWork) {
    idleNoWork = !(await opts.hasReadyWork());
  }

  const verdict = evaluateStuck({
    phase,
    manuallyPaused: isKshetraManuallyPaused(kshetra),
    heartbeatAgeMs: heartbeatAge(kshetra.id, now),
    outcomeRepeatCount: progress.outcomeRepeatCount,
    lastOutcome: progress.lastOutcome,
    idleNoWork,
    thresholds: {
      stuckMs: kshetra.watchdog?.stuckThresholdMs,
      maxRepeat: kshetra.watchdog?.maxOutcomeRepeat,
    },
  });

  if (verdict.stuck && verdict.reason && verdict.remediation) {
    setStuck(kshetra, { reason: verdict.reason, remediation: verdict.remediation, phase });
    pauseKshetra(kshetra, { reason: 'stuck', message: verdict.reason, manual: true });
    await notifyOperator(kshetra, null, 'stuck', verdict.reason, verdict.remediation);
  }
  return verdict;
}
