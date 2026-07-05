import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class GhError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

export interface PrState {
  // GitHub PR state as reported by `gh pr view`: OPEN | MERGED | CLOSED.
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
}

async function run(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new GhError('GH_ERROR', `gh ${args[0]} ${args[1] ?? ''} failed: ${e.stderr ?? e.message ?? String(err)}`, err);
  }
}

// Thin wrapper over the `gh` CLI, scoped to one repo working dir. Used only by
// the PR merge-policy path (3r2); `gh` is already a Shreni prerequisite and is
// used at init-kshetra time to create the beads repo.
export function gh(repoPath: string) {
  return {
    // Open a PR bead-branch → base. Idempotent: if a PR already exists for the
    // head branch, return its URL instead of failing (a re-dispatched or
    // recovered bead must not error on a PR that is already open).
    async prCreate(opts: { base: string; head: string; title: string; body: string }): Promise<string> {
      try {
        const url = await run(
          ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body],
          repoPath,
        );
        // gh prints the PR URL as the last line of stdout.
        return url.split('\n').filter(Boolean).pop() ?? url;
      } catch (err) {
        const msg = (err as GhError).message ?? '';
        if (/already exists|a pull request for branch/i.test(msg)) {
          const existing = await this.prView(opts.head);
          if (existing) return existing.url;
        }
        throw err;
      }
    },

    // View the PR for a head branch. Returns null when there is no PR (or gh is
    // unavailable/unauthenticated) — callers treat null as "nothing to reconcile".
    async prView(head: string): Promise<PrState | null> {
      try {
        const raw = await run(['pr', 'view', head, '--json', 'state,url'], repoPath);
        const parsed = JSON.parse(raw) as { state?: string; url?: string };
        if (!parsed.state || !parsed.url) return null;
        return { state: parsed.state as PrState['state'], url: parsed.url };
      } catch {
        return null;
      }
    },
  };
}