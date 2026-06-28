import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config.js';
import { git } from './git.js';

const execFileAsync = promisify(execFile);

export class BeadsError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BeadsError';
  }
}

async function exec(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('bd', args, {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new BeadsError(
      `bd ${args[0]} failed: ${e.stderr ?? e.message ?? String(err)}`,
      err,
    );
  }
}

// Internal-only bd CLI wrapper. Never called by agents or Vichara directly.
export function bd(kshetra: KshetraConfig) {
  const env: NodeJS.ProcessEnv = { ...process.env, BEADS_DIR: kshetra.beads.path };

  return {
    ready(): Promise<string> {
      return exec(['ready', '--json'], env);
    },

    claim(id: string): Promise<string> {
      return exec(['update', id, '--claim'], env);
    },

    show(id: string): Promise<string> {
      return exec(['show', id, '--json'], env);
    },

    prime(): Promise<string> {
      return exec(['prime'], env);
    },

    close(id: string, note: string): Promise<string> {
      return exec(['close', id, note], env);
    },

    create(title: string, priority: number, type?: string): Promise<string> {
      const args = ['create', title, '-p', String(priority)];
      if (type) args.push('-t', type);
      return exec(args, env);
    },

    remember(insight: string): Promise<string> {
      return exec(['remember', insight], env);
    },

    addNote(id: string, note: string): Promise<string> {
      return exec(['note', id, note], env);
    },

    // Blocking a bead: set status to blocked and append the reason as a note
    flag(id: string, reason: string): Promise<string> {
      return exec(['update', id, '--status', 'blocked', '--append-notes', reason], env);
    },

    list(filters: { status?: string }): Promise<string> {
      const args = ['list', '--json'];
      if (filters.status) args.push('--status', filters.status);
      return exec(args, env);
    },
  };
}

// syncBeads: commit any local changes, pull, push.
// Commit before pull so unstaged changes don't block the rebase.
export async function syncBeads(kshetra: KshetraConfig): Promise<void> {
  const g = git(kshetra.beads.path);

  await g.add('-A');
  await g.commit(`shreni: sync ${new Date().toISOString()}`);

  await g.pull('--rebase', 'origin', 'main');
  await g.push('origin', 'main');
}
