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
import { createTaskBranch, branchName } from './branch.js';
import { squashMergeAndClose } from './merge.js';
import { isHealthBead, measureHealth } from './health.js';
import { setHealthBaseline } from '../kshetra/state.js';

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
  branch: string,
  feedback?: ViharapalaOutput | null,
): Promise<SilpiOutput> {
  const bdClient = bd(kshetra);
  await bdClient.addNote(task.id, `Round ${round}: dispatching Silpi`);
  try {
    const output = await withRetry(`Silpi r${round}`, () => runSilpi(context, round, feedback, branch));
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
  branch: string,
): Promise<ViharapalaOutput> {
  const bdClient = bd(kshetra);
  await bdClient.addNote(task.id, `Round ${round}: dispatching Viharapala`);
  try {
    const output = await withRetry(`Viharapala r${round}`, () =>
      runViharapala(context, silpiOut, round, context.taskDetails, branch),
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
  _branchParam: string,
): Promise<{ approved: boolean; note: string }> {
  if (isHealthBead(task)) {
    return runHealthRepairLoop(kshetra, task);
  }

  const bdClient = bd(kshetra);
  let round = 0;
  let feedback: ViharapalaOutput | null = null;
  let lastSilpiOut: SilpiOutput | null = null;
  // Why the most recent round failed — so the terminal "blocked" message can
  // tell "your own tests/lint failed" apart from "the reviewer rejected you".
  let lastRejectSource: 'tests' | 'reviewer' | null = null;

  emit({ type: 'task_claimed', kshetra: kshetra.id, beadId: task.id, title: task.title });

  // Create the bead branch; workers operate on this branch for the whole lifecycle.
  const branch = await createTaskBranch(task, kshetra);

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;

    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'silpi' });
    const context = await buildAgentContext(kshetra, task);
    const silpiOut = await runSilpi(context, round, feedback, branch);
    lastSilpiOut = silpiOut;

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
      lastRejectSource = 'tests';
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
    feedback = await runViharapala(context, silpiOut, round, context.taskDetails, branch);

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
      // Squash-merge the bead branch into main, close the task, fire Parikshaka
      await squashMergeAndClose(task, kshetra, silpiOut);
      return { approved: true, note: `Approved round ${round}` };
    }
    lastRejectSource = 'reviewer';
  }

  emit({ type: 'task_done', kshetra: kshetra.id, beadId: task.id, title: task.title, approved: false, rounds: round });
  const cause =
    lastRejectSource === 'tests'
      ? "task's own tests/lint kept failing"
      : 'Viharapala kept rejecting';
  await bdClient.flag(task.id, `Blocked after ${round} rounds — ${cause}.`);
  return { approved: false, note: `Blocked after ${round} rounds (${lastRejectSource ?? 'unknown'})` };
}

// Repair loop for [shreni-health] beads. Exempt from the green precondition
// (it is the thing that restores green); gated on "failures must strictly
// decrease" instead. On reaching zero it merges and resets the baseline. If it
// stalls, it quarantines the remaining failures (bumps the accepted baseline so
// feature work isn't wedged forever) and flags for a human.
export async function runHealthRepairLoop(
  kshetra: KshetraConfig,
  task: Task,
): Promise<{ approved: boolean; note: string }> {
  const bdClient = bd(kshetra);
  let round = 0;
  let feedback: ViharapalaOutput | null = null;
  let lastSilpiOut: SilpiOutput | null = null;

  emit({ type: 'task_claimed', kshetra: kshetra.id, beadId: task.id, title: task.title });
  const branch = await createTaskBranch(task, kshetra);

  // Failures on the branch before any repair work — the bar each round must beat.
  let prevFailCount = (await measureHealth(kshetra)).failCount;
  await bdClient.addNote(task.id, `Repair start: ${prevFailCount} failing`);

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;
    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'silpi' });

    const context = await buildAgentContext(kshetra, task);
    const silpiOut = await runSilpi(context, round, feedback, branch);
    lastSilpiOut = silpiOut;
    for (const insight of silpiOut.insights) {
      await bdClient.remember(insight);
    }

    const health = await measureHealth(kshetra);
    emit({
      type: 'silpi_done',
      kshetra: kshetra.id,
      beadId: task.id,
      round,
      summary: silpiOut.summary,
      confidence: silpiOut.confidenceScore,
      files: silpiOut.filesChanged.map(f => f.path),
      lintPassed: silpiOut.lintPassed,
      testsPassed: health.green,
    });

    if (health.green) {
      await bdClient.addNote(task.id, `Round ${round}: suite green — merging`);
      emit({ type: 'task_done', kshetra: kshetra.id, beadId: task.id, title: task.title, approved: true, rounds: round });
      await squashMergeAndClose(task, kshetra, silpiOut);
      setHealthBaseline(kshetra, 0);
      return { approved: true, note: `Suite restored to green round ${round}` };
    }

    if (health.failCount >= 0 && health.failCount < prevFailCount) {
      await bdClient.addNote(
        task.id,
        `Round ${round}: progress ${prevFailCount} -> ${health.failCount} failing`,
      );
      prevFailCount = health.failCount;
      feedback = repairFeedback(health.failCount, true);
    } else {
      await bdClient.addNote(task.id, `Round ${round}: no progress (${health.failCount} failing)`);
      feedback = repairFeedback(health.failCount, false);
    }
  }

  // Stalled: quarantine the remaining failures so the rest of the queue can move,
  // and escalate. Without this, an unfixable suite would wedge the whole Kshetra.
  void lastSilpiOut;
  setHealthBaseline(kshetra, prevFailCount);
  emit({ type: 'task_done', kshetra: kshetra.id, beadId: task.id, title: task.title, approved: false, rounds: round });
  await bdClient.flag(
    task.id,
    `[needs-human] Could not restore green after ${round} rounds — ` +
      `${prevFailCount} failing test(s) quarantined as the accepted baseline. ` +
      `Investigate manually; feature work resumes against this baseline.`,
  );
  return { approved: false, note: `Quarantined ${prevFailCount} failing after ${round} rounds` };
}

function repairFeedback(failCount: number, progress: boolean): ViharapalaOutput {
  const label = failCount >= 0 ? `${failCount}` : 'some';
  return {
    verdict: 'REJECT',
    mustFix: [
      progress
        ? `${label} test(s) still failing — keep fixing, do not touch unrelated code.`
        : `Still ${label} failing and no progress this round — try a different approach; fix the tests, don't delete them.`,
    ],
    overallScore: 0,
    suggestions: [],
    issues: [],
    insights: [],
  };
}
