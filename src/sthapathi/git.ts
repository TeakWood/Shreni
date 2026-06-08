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
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
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
        // Treat "nothing to commit" as success — repo is already clean
        const msg = (err as GitError).message ?? '';
        if (msg.includes('nothing to commit') || msg.includes('nothing added')) return;
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

    async deleteBranch(branch: string, remote = false): Promise<void> {
      await run(['branch', '-d', branch], repoPath);
      if (remote) {
        await run(['push', 'origin', '--delete', branch], repoPath);
      }
    },
  };
}
