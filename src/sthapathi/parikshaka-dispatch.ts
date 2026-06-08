import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput, ParikshakaOutput } from './types.js';
import { runParikshaka } from '../agents/parikshaka.js';
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

export async function commitParikshakaTestFiles(
  kshetra: KshetraConfig,
  task: Task,
  testFiles: string[],
): Promise<void> {
  if (testFiles.length === 0) return;
  const g = git(kshetra);
  for (const file of testFiles) {
    await g.commitFile(file, `parikshaka: add tests for ${task.id}`);
  }
  await g.push('origin', kshetra.repo.mainBranch);
}

export async function fileCoverageGaps(
  kshetra: KshetraConfig,
  parikshakaOutput: ParikshakaOutput,
): Promise<void> {
  if (parikshakaOutput.coverageGaps.length === 0) return;
  const bdClient = bd(kshetra);
  for (const gap of parikshakaOutput.coverageGaps) {
    await bdClient.create(gap.description, gap.priority, 'parikshaka');
  }
  await syncBeads(kshetra);
}

export async function runParikshakaDispatch(
  kshetra: KshetraConfig,
  task: Task,
  silpiOutput: SilpiOutput,
): Promise<void> {
  const personas = await readFileOptional(join(homedir(), '.shreni', 'personas.yaml'));
  const existingTestFiles = await collectTestFiles(kshetra.repo.path);
  const mergedDiff = buildMergedDiff(silpiOutput);

  const parikshakaOutput = await runParikshaka({
    kshetra,
    task,
    mergedDiff,
    existingTestFiles,
    personas: personas || undefined,
  });

  await commitParikshakaTestFiles(kshetra, task, parikshakaOutput.testFilesAdded);
  await fileCoverageGaps(kshetra, parikshakaOutput);
}

// Fire-and-forget: called after merge commit, does not block the main loop
export function dispatchParikshakaAsync(
  kshetra: KshetraConfig,
  task: Task,
  silpiOutput: SilpiOutput,
): void {
  runParikshakaDispatch(kshetra, task, silpiOutput).catch((err: unknown) => {
    console.error(`[parikshaka] dispatch failed for ${task.id}: ${(err as Error).message}`);
  });
}