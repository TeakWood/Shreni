import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { KshetraConfig } from '../kshetra/config.js';
import type { AgentContext, Task, SilpiOutput, ViharapalaOutput } from './types.js';
import { bd } from './beads.js';
import { runSilpi } from '../agents/silpi.js';
import { runViharapala } from '../agents/viharapala.js';
import { withRetry } from './retry.js';
import { ParseError, AgentError } from './errors.js';
import { emit } from './activity-log.js';

async function readFileOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function loadUniversalSkills(): Promise<string> {
  return readFileOptional(join(homedir(), '.shreni', 'skills', 'SKILLS.md'));
}

async function loadScopedSkills(kshetra: KshetraConfig, relatedFiles?: string[]): Promise<string> {
  if (!relatedFiles?.length) return '';
  const seenDirs = new Set<string>();
  const parts: string[] = [];
  for (const file of relatedFiles) {
    const dir = dirname(join(kshetra.repo.path, file));
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const content = await readFileOptional(join(dir, 'CLAUDE.md'));
    if (content) parts.push(content);
  }
  return parts.join('\n');
}

export async function buildAgentContext(kshetra: KshetraConfig, task: Task): Promise<AgentContext> {
  const bdClient = bd(kshetra);

  const conventionsPath = kshetra.conventions?.styleGuide
    ? join(kshetra.repo.path, kshetra.conventions.styleGuide)
    : null;
  const architecturePath = kshetra.conventions?.architecture
    ? join(kshetra.repo.path, kshetra.conventions.architecture)
    : null;

  const [projectMemory, taskDetails, projectSkills, universalSkills, scopedSkills, conventions, architecture] =
    await Promise.all([
      bdClient.prime(),
      bdClient.show(task.id),
      readFileOptional(join(kshetra.repo.path, 'CLAUDE.md')),
      loadUniversalSkills(),
      loadScopedSkills(kshetra, task.context?.relatedFiles),
      conventionsPath ? readFileOptional(conventionsPath) : Promise.resolve(''),
      architecturePath ? readFileOptional(architecturePath) : Promise.resolve(''),
    ]);

  return {
    kshetra,
    task,
    projectMemory,
    taskDetails,
    universalSkills,
    projectSkills,
    scopedSkills,
    conventions,
    architecture,
    ragChunks: '',
  };
}

export async function runSilpiSafe(
  kshetra: KshetraConfig,
  task: Task,
  context: AgentContext,
  round: number,
  feedback?: ViharapalaOutput | null,
): Promise<SilpiOutput> {
  const bdClient = bd(kshetra);
  await bdClient.addNote(task.id, `Round ${round}: dispatching Silpi`);
  try {
    const output = await withRetry(`Silpi r${round}`, () => runSilpi(context, round, feedback));
    await bdClient.addNote(task.id, `Round ${round}: Silpi submitted`);
    return output;
  } catch (err) {
    if (err instanceof ParseError) {
      await bdClient.addNote(task.id, `Round ${round}: Silpi output malformed — ${err.message}`);
      throw new AgentError('MALFORMED_OUTPUT', { task, round, cause: err });
    }
    await bdClient.addNote(task.id, `Round ${round}: Silpi failed after retries — ${(err as Error).message}`);
    throw new AgentError('API_FAILURE', { task, round, cause: err });
  }
}

export async function runViharapalaSafe(
  kshetra: KshetraConfig,
  task: Task,
  context: AgentContext,
  silpiOut: SilpiOutput,
  round: number,
): Promise<ViharapalaOutput> {
  const bdClient = bd(kshetra);
  await bdClient.addNote(task.id, `Round ${round}: dispatching Viharapala`);
  try {
    const output = await withRetry(`Viharapala r${round}`, () =>
      runViharapala(context, silpiOut, round, context.taskDetails),
    );
    await bdClient.addNote(task.id, `Round ${round}: ${output.verdict}`);
    return output;
  } catch (err) {
    if (err instanceof ParseError) {
      await bdClient.addNote(task.id, `Round ${round}: Viharapala output malformed — ${err.message}`);
      throw new AgentError('MALFORMED_OUTPUT', { task, round, cause: err });
    }
    await bdClient.addNote(task.id, `Round ${round}: Viharapala failed after retries — ${(err as Error).message}`);
    throw new AgentError('API_FAILURE', { task, round, cause: err });
  }
}

export async function runSilpiViharapalaLoop(
  kshetra: KshetraConfig,
  task: Task,
  _branch: string,
): Promise<{ approved: boolean; note: string }> {
  const bdClient = bd(kshetra);
  let round = 0;
  let feedback: ViharapalaOutput | null = null;

  emit({ type: 'task_claimed', kshetra: kshetra.id, beadId: task.id, title: task.title });

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;

    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'silpi' });
    const context = await buildAgentContext(kshetra, task);
    const silpiOut = await runSilpi(context, round, feedback);

    emit({
      type: 'silpi_done',
      kshetra: kshetra.id,
      beadId: task.id,
      round,
      summary: silpiOut.summary,
      confidence: silpiOut.confidenceScore,
      files: silpiOut.filesChanged.map(f => f.path),
      lintPassed: silpiOut.lintPassed,
      testsPassed: silpiOut.testsPassed,
    });

    for (const insight of silpiOut.insights) {
      await bdClient.remember(insight);
    }

    if (!silpiOut.testsPassed || !silpiOut.lintPassed) {
      await bdClient.addNote(task.id, `Round ${round}: lint/tests failed`);
      feedback = {
        verdict: 'REJECT',
        mustFix: ['Tests or lint failed — fix before resubmitting'],
        overallScore: 0,
        suggestions: [],
        issues: [],
        insights: [],
      };
      continue;
    }

    await bdClient.addNote(task.id, `Round ${round}: submitted for review`);

    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'viharapala' });
    feedback = await runViharapala(context, silpiOut, round, context.taskDetails);

    emit({
      type: 'viharapala_done',
      kshetra: kshetra.id,
      beadId: task.id,
      round,
      verdict: feedback.verdict,
      score: feedback.overallScore,
      mustFix: feedback.mustFix,
    });

    for (const insight of feedback.insights) {
      await bdClient.remember(insight);
    }

    await bdClient.addNote(task.id, `Round ${round}: ${feedback.verdict}`);

    if (feedback.verdict === 'APPROVE') {
      emit({ type: 'task_done', kshetra: kshetra.id, beadId: task.id, title: task.title, approved: true, rounds: round });
      return { approved: true, note: `Approved round ${round}` };
    }
  }

  emit({ type: 'task_done', kshetra: kshetra.id, beadId: task.id, title: task.title, approved: false, rounds: round });
  return { approved: false, note: `Blocked after ${round} rounds` };
}