import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads, BeadsError } from './beads.js';
import { pauseKshetra, recordStall } from '../kshetra/state.js';
import { git, GitError } from './git.js';
import { branchName } from './branch.js';
import { appendNotification } from './notifications.js';

export class ParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ParseError';
  }
}

// Thrown when an in-flight agent run is deliberately aborted for self-heal
//: `shreni resume` on a hung (reason:'stuck') worker cancels
// the wedged provider subprocess so the worker can RECOVER in-process. This is a
// SANCTIONED cancellation, not a failure — handleCycleError/classifyError must
// never see it (it would flag the bead and clean the branch out from under the
// recovery path), so runTaskSafely intercepts it and returns quietly.
export class AgentAbortedError extends Error {
  constructor(message = 'agent run aborted for self-heal') {
    super(message);
    this.name = 'AgentAbortedError';
  }
}

export type AgentErrorKind = 'MALFORMED_OUTPUT' | 'API_FAILURE';

export class AgentError extends Error {
  constructor(
    public readonly kind: AgentErrorKind,
    public readonly context: { task: Task; round: number; cause?: unknown },
  ) {
    super(`${kind}: ${(context.cause as Error)?.message ?? String(context.cause)}`);
    this.name = 'AgentError';
  }
}

// Thrown when the PolicySource pre-run check denies a run (epg.5). The default
// static policy always allows, so this never fires locally; an optional policy
// extension may deny (e.g. a gated tier), and the reason is surfaced. Treated as
// a normal run failure by the caller's retry/error handling.
export class RunNotPermittedError extends Error {
  constructor(agentName: string, reason: string) {
    super(`${agentName}: run not permitted — ${reason}`);
    this.name = 'RunNotPermittedError';
  }
}

type ErrorClass = 'API_DOWN' | 'AGENT_FAILED' | 'MALFORMED_OUTPUT' | 'GIT_FAILED' | 'BD_FAILED' | 'UNKNOWN';

function classifyError(err: unknown): ErrorClass {
  if (err instanceof BeadsError) return 'BD_FAILED';
  if (err instanceof GitError) return 'GIT_FAILED';
  if (err instanceof AgentError) {
    return err.kind === 'MALFORMED_OUTPUT' ? 'MALFORMED_OUTPUT' : 'AGENT_FAILED';
  }
  const e = err as { status?: number; message?: string; code?: string };
  const apiDownStatuses = [429, 502, 503, 529];
  if (e.status !== undefined && apiDownStatuses.includes(e.status)) return 'API_DOWN';
  const msg = e.message ?? e.code ?? '';
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
    return 'API_DOWN';
  }
  return 'UNKNOWN';
}

// The bead branch is created at the start of every cycle but only deleted on
// the success path (squashMergeAndClose). On a terminal failure we abandon the
// branch here so it can't linger and silently wedge the next pickup() — a
// leftover branch makes preFlightCheck throw on every poll. Best-effort: a
// cleanup failure must never mask the original cycle error. NOT called for
// GIT_FAILED / merge conflicts, where the branch is deliberately kept for
// human inspection.
export async function cleanupBranch(kshetra: KshetraConfig, task: Task): Promise<void> {
  const g = git(kshetra);
  const branch = branchName(task);
  try {
    if (!(await g.branchExists(branch))) return;
    // Must be off the branch to delete it; force-delete since the abandoned
    // branch may hold partial commits we are discarding.
    await g.checkout(kshetra.repo.mainBranch);
    await g.deleteBranch(branch, { force: true });
  } catch (err) {
    console.warn(`[shreni:${kshetra.id}] failed to clean up branch ${branch}: ${(err as Error).message}`);
  }
}

// Notify a human of an end-state / stuck-state that needs intervention. Appends
// a durable record to the per-Kshetra notifications feed (polled by Phalaka) and
// logs it. The message names the cause and, when provided, lists remediation
// steps. Never throws — notification must not crash the worker.
export async function notifyOperator(
  kshetra: KshetraConfig,
  task: Task | null,
  event: string,
  reason?: string,
  remediation?: string,
): Promise<void> {
  const lines = [`[${kshetra.name}] ${event.replace(/_/g, ' ').toUpperCase()}`];
  if (task) lines.push(`Bead: ${task.id} — ${task.title}`);
  if (reason) lines.push(`Cause: ${reason}`);
  if (remediation) lines.push(`Try:\n${remediation}`);
  const message = lines.join('\n');

  appendNotification(kshetra.id, {
    ts: new Date().toISOString(),
    event,
    beadId: task?.id,
    reason,
    remediation,
    message,
  });
  console.error(`[shreni notify:${kshetra.id}] ${message}`);
}

export async function handleCycleError(
  kshetra: KshetraConfig,
  task: Task | null,
  err: Error,
): Promise<void> {
  const bdClient = bd(kshetra);

  // Track repeating cycle errors so the watchdog can trip on a stall loop
  // (e.g. the same git/agent failure recurring across polls).
  const errorClass = classifyError(err);
  recordStall(kshetra, `cycle:${errorClass}`);

  switch (errorClass) {
    case 'API_DOWN':
      if (task) {
        await bdClient.addNote(task.id, `Paused: API unavailable — ${err.message}. Will retry.`);
        // The retry re-picks the task and creates a fresh branch, so drop the
        // current one — otherwise preFlightCheck would reject the retry.
        await cleanupBranch(kshetra, task);
      }
      pauseKshetra(kshetra, {
        reason: 'api_down',
        message: err.message,
        cooldownMs: 5 * 60 * 1000,
      });
      await notifyOperator(kshetra, task, 'api_down');
      break;

    case 'AGENT_FAILED':
      if (task) {
        await bdClient.flag(task.id, `Agent failed: ${err.message}`);
        await syncBeads(kshetra);
        await cleanupBranch(kshetra, task);
      }
      await notifyOperator(kshetra, task, 'agent_failed');
      break;

    case 'MALFORMED_OUTPUT':
      if (task) {
        await bdClient.flag(task.id, `Malformed output after retries: ${err.message}`);
        await syncBeads(kshetra);
        await cleanupBranch(kshetra, task);
      }
      await notifyOperator(kshetra, task, 'agent_failed');
      break;

    case 'GIT_FAILED':
      if (task) {
        await bdClient.flag(task.id, `Git failure: ${err.message}. Branch kept.`);
        await syncBeads(kshetra);
      }
      pauseKshetra(kshetra, {
        reason: 'git_failed',
        message: err.message,
        manual: true,
      });
      await notifyOperator(kshetra, task, 'git_failed');
      break;

    case 'BD_FAILED':
      pauseKshetra(kshetra, {
        reason: 'bd_failed',
        message: err.message,
        manual: true,
      });
      await notifyOperator(kshetra, null, 'bd_failed');
      break;

    default:
      if (task) {
        await bdClient.flag(task.id, `Unexpected error: ${err.message}`);
        await syncBeads(kshetra);
        await cleanupBranch(kshetra, task);
      }
      await notifyOperator(kshetra, task, 'unknown_error');
  }
}