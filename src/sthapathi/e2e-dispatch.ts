import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, E2EOutput } from './types.js';
import { runE2E } from '../agents/e2e.js';
import { bd, syncBeads } from './beads.js';
import { git } from './git.js';

async function readFileOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function collectTestFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith('.test.ts') || e.name.endsWith('.spec.ts')) {
        results.push(full.slice(repoPath.length + 1));
      }
    }
  }

  await walk(repoPath);
  return results;
}

export function buildMergedDiff(output: SilpiOutput): string {
  return output.filesChanged
    .map(f => `--- ${f.path}\n${f.diff}`)
    .join('\n\n');
}

export async function commitE2ETestFiles(
  kshetra: KshetraConfig,
  task: Task,
  testFiles: string[],
): Promise<void> {
  if (testFiles.length === 0) return;
  const g = git(kshetra);
  for (const file of testFiles) {
    await g.commitFile(file, `e2e: add tests for ${task.id}`);
  }
  await g.push('origin', kshetra.repo.mainBranch);
}

export async function fileCoverageGaps(
  kshetra: KshetraConfig,
  e2eOutput: E2EOutput,
): Promise<void> {
  if (e2eOutput.coverageGaps.length === 0) return;
  const bdClient = bd(kshetra);
  for (const gap of e2eOutput.coverageGaps) {
    await bdClient.create(gap.description, gap.priority, 'e2e');
  }
  await syncBeads(kshetra);
}

export async function runE2EDispatch(
  kshetra: KshetraConfig,
  task: Task,
  silpiOutput: SilpiOutput,
): Promise<void> {
  const personas = await readFileOptional(join(homedir(), '.shreni', 'personas.yaml'));
  const existingTestFiles = await collectTestFiles(kshetra.repo.path);
  const mergedDiff = buildMergedDiff(silpiOutput);

  const e2eOutput = await runE2E({
    kshetra,
    task,
    mergedDiff,
    existingTestFiles,
    personas: personas || undefined,
  });

  await commitE2ETestFiles(kshetra, task, e2eOutput.testFilesAdded);
  await fileCoverageGaps(kshetra, e2eOutput);
}

// Fire-and-forget: called after merge commit, does not block the main loop
export function dispatchE2EAsync(
  kshetra: KshetraConfig,
  task: Task,
  silpiOutput: SilpiOutput,
): void {
  runE2EDispatch(kshetra, task, silpiOutput).catch((err: unknown) => {
    console.error(`[e2e] dispatch failed for ${task.id}: ${(err as Error).message}`);
  });
}