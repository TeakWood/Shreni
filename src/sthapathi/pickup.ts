import { z } from 'zod';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';
import { checkHealth, ensureHealthBead, isHealthBead } from './health.js';
import { recordProgress, recordStall } from '../kshetra/state.js';

export class PreFlightError extends Error {
  constructor(
    public readonly task: Task,
    message: string,
  ) {
    super(message);
    this.name = 'PreFlightError';
  }
}

const BeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number().int().min(0).max(4),
  status: z.string(),
  description: z.string().optional(),
  notes: z.string().optional(),
});

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function parseReadyOutput(raw: string): Task[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tasks: Task[] = [];
  for (const item of parsed) {
    const result = BeadsIssueSchema.safeParse(item);
    if (!result.success) continue;
    const r = result.data;
    tasks.push({
      id: r.id,
      slug: toSlug(r.title),
      title: r.title,
      description: r.description,
      status: 'pending',
      priority: r.priority,
      notes: r.notes,
    });
  }
  return tasks;
}

// Stable sort: P0 first, then preserve arrival order (FIFO) within same priority
export function pickNext(tasks: Task[]): Task | null {
  if (tasks.length === 0) return null;
  const sorted = tasks.slice().sort((a, b) => a.priority - b.priority);
  return sorted[0] ?? null;
}

export async function preFlightCheck(task: Task, kshetra: KshetraConfig): Promise<void> {
  const g = git(kshetra);
  const main = kshetra.repo.mainBranch;

  await g.checkout(main);

  const status = await g.status();
  const dirty = [...status.modified, ...status.staged];
  if (dirty.length > 0) {
    throw new PreFlightError(task, `dirty working tree: ${dirty.join(', ')}`);
  }

  await g.pull('--rebase', 'origin', main);

  const branch = `bead-${task.id}/${task.slug}`;
  if (await g.branchExists(branch)) {
    throw new PreFlightError(task, `branch already exists: ${branch}`);
  }
}

// SELECT (read-only). Picks the highest-priority ready bead. Performs NO git ops
// and NO claim, so it is safe to call on every poll — the scheduler only commits
// to mutating the work tree once it advances a selected task into PREPARE. This
// separation is what stops a poll from checking out main under an in-flight agent
// (see the Sthapathi workflow design §4.2).
export async function selectNext(kshetra: KshetraConfig): Promise<Task | null> {
  const raw = await bd(kshetra).ready();
  return pickNext(parseReadyOutput(raw));
}

// PREPARE (the ONLY mutator in the pickup path) + bd claim. Syncs beads, runs
// preFlightCheck (checkout main, pull, branch guard) and the health gate, then
// claims. Returns the task when it is ready to work, or null when preflight
// rejects or the base suite is red — both logged, so a wedge is never silent.
export async function prepareTask(task: Task, kshetra: KshetraConfig): Promise<Task | null> {
  await syncBeads(kshetra);
  try {
    await preFlightCheck(task, kshetra);
  } catch (err) {
    if (err instanceof PreFlightError) {
      // Surface the rejection — otherwise a leftover branch or persistently
      // dirty tree wedges the worker silently, returning null on every poll
      // with no clue why nothing is progressing. Record the stall so the
      // watchdog trips if the same rejection repeats.
      recordStall(kshetra, `preflight: ${err.message}`);
      console.warn(`[shreni prepare:${kshetra.id}] preflight rejected ${task.id}: ${err.message}`);
      return null;
    }
    throw err;
  }

  // Health gate: a fresh feature task only starts when the base suite is green
  // (modulo the accepted baseline). preFlightCheck has put us on a clean, pulled
  // main, so this measures the right tree. A red base does not start the task —
  // it queues a P0 repair bead instead, which is exempt from this gate. This
  // runs at the prepare boundary only, never mid-loop, so it can't interfere with
  // an in-flight Silpi↔Viharapala round.
  if (!isHealthBead(task)) {
    const health = await checkHealth(kshetra);
    if (!health.green) {
      const created = await ensureHealthBead(kshetra, health.failCount);
      recordStall(kshetra, 'base suite red');
      console.warn(
        `[shreni prepare:${kshetra.id}] base suite red ` +
          `(${health.failCount} failing > baseline ${health.baseline}); ` +
          `deferring ${task.id}, ${created ? 'queued' : 'awaiting'} health repair`,
      );
      return null;
    }
  }

  await bd(kshetra).claim(task.id);
  // Forward progress: a bead was successfully claimed — clear any stall counter.
  recordProgress(kshetra);
  return task;
}