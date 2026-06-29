import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads, BeadsError } from './beads.js';
import { pauseKshetra } from '../kshetra/state.js';
import { git, GitError } from './git.js';
import { branchName } from './branch.js';

export class ParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ParseError';
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

// Stub — notifies a human via Vichara (not yet implemented)
export async function notifyVichara(
  _kshetra: KshetraConfig,
  _task: Task | null,
  _event: string,
): Promise<void> {
  // Phase 5: implement Vichara notifications
}

export async function handleCycleError(
  kshetra: KshetraConfig,
  task: Task | null,
  err: Error,
): Promise<void> {
  const bdClient = bd(kshetra);

  switch (classifyError(err)) {
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
      await notifyVichara(kshetra, task, 'api_down');
      break;

    case 'AGENT_FAILED':
      if (task) {
        await bdClient.flag(task.id, `Agent failed: ${err.message}`);
        await syncBeads(kshetra);
        await cleanupBranch(kshetra, task);
      }
      await notifyVichara(kshetra, task, 'agent_failed');
      break;

    case 'MALFORMED_OUTPUT':
      if (task) {
        await bdClient.flag(task.id, `Malformed output after retries: ${err.message}`);
        await syncBeads(kshetra);
        await cleanupBranch(kshetra, task);
      }
      await notifyVichara(kshetra, task, 'agent_failed');
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
      await notifyVichara(kshetra, task, 'git_failed');
      break;

    case 'BD_FAILED':
      pauseKshetra(kshetra, {
        reason: 'bd_failed',
        message: err.message,
        manual: true,
      });
      await notifyVichara(kshetra, null, 'bd_failed');
      break;

    default:
      if (task) {
        await bdClient.flag(task.id, `Unexpected error: ${err.message}`);
        await syncBeads(kshetra);
        await cleanupBranch(kshetra, task);
      }
      await notifyVichara(kshetra, task, 'unknown_error');
  }
}