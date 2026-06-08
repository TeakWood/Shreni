import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';

export function parseLastNote(notes: string | undefined): string {
  if (!notes) return '';
  const lines = notes.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function parseInFlightTasks(raw: string): Task[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tasks: Task[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (typeof item.id !== 'string' || typeof item.title !== 'string') continue;
    tasks.push({
      id: item.id,
      slug: String(item.slug ?? item.id),
      title: item.title,
      status: 'in_progress',
      priority: typeof item.priority === 'number' ? item.priority : 2,
      round: typeof item.round === 'number' ? item.round : 1,
      notes: typeof item.notes === 'string' ? item.notes : undefined,
    });
  }
  return tasks;
}

// Stub — full dispatch scheduling implemented in Phase 5
function scheduleResume(
  _kshetra: KshetraConfig,
  task: Task,
  stage: 'silpi' | 'viharapala' | 'merge',
  _opts?: { silpiOut?: unknown },
): void {
  console.info(`[recover] Scheduled resume: ${task.id} from ${stage}`);
}

export async function recoverKshetra(kshetra: KshetraConfig): Promise<void> {
  const raw = await bd(kshetra).list({ status: 'in_progress' });
  const inFlight = parseInFlightTasks(raw);

  for (const task of inFlight) {
    const lastNote = parseLastNote(task.notes);
    const branch = `bead-${task.id}/${task.slug}`;
    const hasBranch = await git(kshetra).branchExists(branch);

    console.info(`[recover] ${kshetra.id}: ${task.id} — "${lastNote}"`);

    if (lastNote.includes('claiming') && !hasBranch) {
      await git(kshetra).createBranch(task);
      scheduleResume(kshetra, task, 'silpi');
    } else if (lastNote.includes('dispatching Silpi')) {
      await bd(kshetra).addNote(
        task.id,
        `Round ${task.round}: resuming Silpi after restart`,
      );
      scheduleResume(kshetra, task, 'silpi');
    } else if (lastNote.includes('Silpi submitted')) {
      await bd(kshetra).addNote(
        task.id,
        `Round ${task.round}: resuming at Viharapala after restart`,
      );
      scheduleResume(kshetra, task, 'viharapala');
    } else if (lastNote.includes('dispatching Viharapala')) {
      await bd(kshetra).addNote(
        task.id,
        `Round ${task.round}: resuming Viharapala after restart`,
      );
      scheduleResume(kshetra, task, 'viharapala');
    } else if (lastNote.includes('APPROVE')) {
      const alreadyMerged = await git(kshetra).isAncestor(branch, 'main');
      if (alreadyMerged) {
        await bd(kshetra).close(task.id, 'Recovered: merged before crash');
        await syncBeads(kshetra);
      } else {
        scheduleResume(kshetra, task, 'merge');
      }
    } else if (lastNote.includes('Paused: API unavailable')) {
      scheduleResume(kshetra, task, 'silpi');
    } else {
      console.info(`[recover] ${task.id} is blocked/failed — skipping`);
    }
  }
}