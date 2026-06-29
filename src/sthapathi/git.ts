import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Task } from './types.js';
import type { KshetraConfig } from '../kshetra/config.js';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function run(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    // trimEnd only — leading whitespace in stdout is meaningful for git --porcelain format
    return { stdout: result.stdout.trimEnd(), stderr: result.stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; code?: string | number };
    throw new GitError(
      'GIT_ERROR',
      `git ${args[0]} failed: ${e.stderr ?? e.message ?? String(err)}`,
      err,
    );
  }
}

export function git(kshetraOrPath: KshetraConfig | string) {
  const repoPath =
    typeof kshetraOrPath === 'string' ? kshetraOrPath : kshetraOrPath.repo.path;

  return {
    async checkout(ref: string): Promise<void> {
      await run(['checkout', ref], repoPath);
    },

    async pull(...args: string[]): Promise<void> {
      await run(['pull', ...args], repoPath);
    },

    async push(...args: string[]): Promise<void> {
      await run(['push', ...args], repoPath);
    },

    async fetch(...args: string[]): Promise<void> {
      await run(['fetch', ...args], repoPath);
    },

    async add(...args: string[]): Promise<void> {
      await run(['add', ...args], repoPath);
    },

    async commit(message: string, ...args: string[]): Promise<void> {
      try {
        await run(['commit', '-m', message, ...args], repoPath);
      } catch (err) {
        // git exits 1 when nothing to commit; message appears in stdout, not stderr
        const cause = (err as GitError).cause as { stdout?: string } | undefined;
        const combined = `${(err as GitError).message} ${cause?.stdout ?? ''}`;
        if (combined.includes('nothing to commit') || combined.includes('nothing added')) return;
        throw err;
      }
    },

    async merge(...args: string[]): Promise<void> {
      await run(['merge', ...args], repoPath);
    },

    async rebase(...args: string[]): Promise<void> {
      await run(['rebase', ...args], repoPath);
    },

    async createBranch(task: Task): Promise<string> {
      const branch = `bead-${task.id}/${task.slug}`;
      await run(['checkout', '-b', branch], repoPath);
      return branch;
    },

    async headSha(ref = 'HEAD'): Promise<string> {
      const { stdout } = await run(['rev-parse', ref], repoPath);
      return stdout.trim();
    },

    // Current branch name, or 'HEAD' when detached.
    async currentBranch(): Promise<string> {
      const { stdout } = await run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      return stdout.trim();
    },

    // Move a branch ref to point at <ref> without checking it out. Used to
    // restore main / salvage stray commits during off-branch recovery.
    async forceBranch(name: string, ref: string): Promise<void> {
      await run(['branch', '-f', name, ref], repoPath);
    },

    async branchExists(branch: string): Promise<boolean> {
      try {
        await run(['rev-parse', '--verify', branch], repoPath);
        return true;
      } catch {
        return false;
      }
    },

    async status(): Promise<{ modified: string[]; staged: string[]; untracked: string[] }> {
      const { stdout } = await run(['status', '--porcelain'], repoPath);
      const modified: string[] = [];
      const staged: string[] = [];
      const untracked: string[] = [];

      for (const line of stdout.split('\n').filter(Boolean)) {
        const index = line[0];
        const worktree = line[1];
        const file = line.slice(3);

        if (index === '?' && worktree === '?') {
          untracked.push(file);
        } else {
          if (index !== ' ' && index !== '?') staged.push(file);
          if (worktree !== ' ' && worktree !== '?') modified.push(file);
        }
      }

      return { modified, staged, untracked };
    },

    async revsBetween(from: string, to: string): Promise<string[]> {
      const { stdout } = await run(['rev-list', `${from}..${to}`], repoPath);
      return stdout.split('\n').filter(Boolean);
    },

    // Dry-run conflict check using merge-tree
    async mergeTree(branch: string, target: string): Promise<string[]> {
      try {
        const { stdout } = await run(
          ['merge-tree', '--write-tree', branch, target],
          repoPath,
        );
        // merge-tree exits 0 on clean merge, 1 on conflicts
        // When conflicts exist they appear in stdout — parse conflicted paths
        const conflictedFiles: string[] = [];
        for (const line of stdout.split('\n')) {
          if (line.startsWith('CONFLICT')) {
            const match = line.match(/Merge conflict in (.+)/);
            if (match) conflictedFiles.push(match[1]);
          }
        }
        return conflictedFiles;
      } catch (err) {
        // Exit code 1 with conflict output — parse it
        const e = err as GitError;
        const output = e.message ?? '';
        const conflictedFiles: string[] = [];
        for (const line of output.split('\n')) {
          if (line.includes('Merge conflict in')) {
            const match = line.match(/Merge conflict in (.+)/);
            if (match) conflictedFiles.push(match[1].trim());
          }
        }
        return conflictedFiles;
      }
    },

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
      try {
        await run(['merge-base', '--is-ancestor', ancestor, descendant], repoPath);
        return true;
      } catch {
        return false;
      }
    },

    async diffMerged(branch: string): Promise<string> {
      const { stdout } = await run(
        ['diff', `main...${branch}`, '--stat'],
        repoPath,
      );
      return stdout;
    },

    async branchDiff(branchPrefix: string): Promise<string> {
      const { stdout } = await run(
        ['diff', `main...${branchPrefix}`, '--unified=3'],
        repoPath,
      );
      return stdout;
    },

    async commitFile(filePath: string, message: string): Promise<void> {
      await run(['add', filePath], repoPath);
      await this.commit(message);
    },

    async deleteBranch(
      branch: string,
      opts: { remote?: boolean; force?: boolean } = {},
    ): Promise<void> {
      // -D (force) is required to remove a branch holding commits that were
      // never merged — e.g. cleaning up after a failed cycle where the agent
      // committed partial work we are discarding. -d alone refuses those.
      await run(['branch', opts.force ? '-D' : '-d', branch], repoPath);
      if (opts.remote) {
        await run(['push', 'origin', '--delete', branch], repoPath);
      }
    },
  };
}
