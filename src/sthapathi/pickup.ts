import { z } from 'zod';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';

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
  const status = await g.status();
  const dirty = [...status.modified, ...status.staged];
  if (dirty.length > 0) {
    throw new PreFlightError(task, `dirty working tree: ${dirty.join(', ')}`);
  }
  const branch = `bead-${task.id}/${task.slug}`;
  if (await g.branchExists(branch)) {
    throw new PreFlightError(task, `branch already exists: ${branch}`);
  }
}

// bd claim is called ONLY here. Returns the claimed task or null if nothing to pick up.
export async function pickup(kshetra: KshetraConfig): Promise<Task | null> {
  await syncBeads(kshetra);
  const raw = await bd(kshetra).ready();
  const tasks = parseReadyOutput(raw);
  const task = pickNext(tasks);
  if (!task) return null;
  try {
    await preFlightCheck(task, kshetra);
  } catch (err) {
    if (err instanceof PreFlightError) return null;
    throw err;
  }
  await bd(kshetra).claim(task.id);
  return task;
}