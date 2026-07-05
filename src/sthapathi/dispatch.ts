import { readFile } from 'fs/promises';
import { join } from 'path';
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
import { squashMergeAndClose, openPrAndDefer, resolveMergePolicy } from './merge.js';
import { isHealthBead, measureHealth } from './health.js';
import { runLintGate } from './lint.js';
import { recordProgress, setHealthBaseline } from '../kshetra/state.js';
import { AgentAbortedError } from './errors.js';
import { captureGuard, assertOnBranch, recoverOffBranch, OffBranchError, type BranchGuard } from './guard.js';

// Bail out of a round loop the instant a self-heal abort is requested, so the
// worker's RECOVER isn't racing a fresh round starting between agent calls
//. Throwing AgentAbortedError unwinds cleanly through
// runTaskSafely, which swallows it (no cycle-error handling).
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAbortedError();
}

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

export async function buildAgentContext(kshetra: KshetraConfig, task: Task): Promise<AgentContext> {
  const bdClient = bd(kshetra);

  // Injection flip (the agent-execution design §3.1): the provider CLI now loads the
  // repo's own config natively (instruction file, `.claude/` skills/rules/
  // subagents, per-dir CLAUDE.md, the @-imported conventions docs), so Shreni no
  // longer reads-and-injects any of that — doing so would double-load. Shreni
  // injects only what has no repo-native home: bd's workflow context, the task
  // details + acceptance criteria, the cross-project universalSkills, and the
  // reviewer-only reviewGuide (§3.3 — no provider has a reviewer-only native
  // file, so this one stays Shreni-injected).
  const reviewGuidePath = kshetra.conventions?.reviewGuide
    ? join(kshetra.repo.path, kshetra.conventions.reviewGuide)
    : null;
  const [projectMemory, taskDetails, universalSkills, reviewGuide] = await Promise.all([
    bdClient.prime(),
    bdClient.show(task.id),
    loadUniversalSkills(),
    reviewGuidePath ? readFileOptional(reviewGuidePath) : Promise.resolve(''),
  ]);

  return {
    kshetra,
    task,
    projectMemory,
    taskDetails,
    universalSkills,
    reviewGuide,
    // NOT YET IMPLEMENTED: RAG codebase-search retrieval is not wired up, so no
    // relevant-code chunks are injected. Silpi guards on truthiness
    // (silpi.ts: `if (context.ragChunks)`), so an empty string simply omits the
    // "== RELEVANT CODE ==" section. Populate this once retrieval lands.
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

// Verify the agent stayed on the bead branch and left main untouched. On a
// violation, salvage any stray commits, restore main, flag the bead, and return
// an abort result for the caller to return immediately. Returns null when clean.
async function guardAfterAgent(
  kshetra: KshetraConfig,
  task: Task,
  guard: BranchGuard,
  round: number,
): Promise<{ approved: boolean; note: string } | null> {
  try {
    await assertOnBranch(kshetra, guard);
    return null;
  } catch (err) {
    if (!(err instanceof OffBranchError)) throw err;
    const salvage = await recoverOffBranch(kshetra, task, guard);
    const salvageNote = salvage ? ` Stray commits preserved on "${salvage}".` : '';
    emit({ type: 'task_done', kshetra: kshetra.id, beadId: task.id, title: task.title, approved: false, rounds: round });
    await bd(kshetra).flag(
      task.id,
      `Aborted round ${round}: agent left the bead branch — ${err.message}. ` +
        `main restored to origin.${salvageNote} Investigate manually.`,
    );
    return { approved: false, note: `Aborted: off-branch (${err.detail.actualHead})` };
  }
}

export async function runSilpiViharapalaLoop(
  kshetra: KshetraConfig,
  task: Task,
  _branchParam: string,
  signal?: AbortSignal,
): Promise<{ approved: boolean; note: string }> {
  if (isHealthBead(task)) {
    return runHealthRepairLoop(kshetra, task, signal);
  }

  const bdClient = bd(kshetra);
  let round = 0;
  let feedback: ViharapalaOutput | null = null;
  let lastSilpiOut: SilpiOutput | null = null;
  // Why the most recent round failed — so the terminal "blocked" message can
  // tell "your own tests/lint failed" apart from "the reviewer rejected you".
  let lastRejectSource: 'tests' | 'reviewer' | null = null;

  emit({ type: 'task_claimed', kshetra: kshetra.id, beadId: task.id, title: task.title });
  // Claiming a bead is forward progress — stamp liveness and clear the stall track so
  // a fresh cycle never re-trips the watchdog on a stale repeat count (the design §3.2).
  recordProgress(kshetra);

  // Create the bead branch; workers operate on this branch for the whole lifecycle.
  const branch = await createTaskBranch(task, kshetra);
  // Snapshot the sanctioned starting point (on-branch, main at origin) so each
  // round can prove the agent didn't commit to main or wander off-branch.
  const guard = await captureGuard(kshetra, branch);

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;
    throwIfAborted(signal);

    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'silpi' });
    const context = await buildAgentContext(kshetra, task);
    const silpiOut = await runSilpi(context, round, feedback, branch, signal);
    lastSilpiOut = silpiOut;

    const offBranch = await guardAfterAgent(kshetra, task, guard, round);
    if (offBranch) return offBranch;

    // Baseline-aware test gate: treat the suite as passing when the current
    // failCount is within the accepted baseline of known/quarantined failures.
    // This mirrors the health-repair loop and the pickup gate, so pre-existing
    // unrelated failures (or ones quarantined into the baseline) don't auto-
    // reject an otherwise clean diff. A task that ADDS failures (failCount >
    // baseline) makes health.green false and still rejects, so real regressions
    // are not let through. silpiOut.testsPassed is kept for logging only.
    const health = await measureHealth(kshetra);
    // Enforced lint gate: run stack.lintCommand ourselves rather than trusting
    // Silpi's self-reported lintPassed (the toolchain design §3.3). When no lint gate
    // is configured, runLintGate skips-and-logs and reports passed=true.
    const lint = await runLintGate(kshetra);

    emit({
      type: 'silpi_done',
      kshetra: kshetra.id,
      beadId: task.id,
      round,
      summary: silpiOut.summary,
      confidence: silpiOut.confidenceScore,
      files: silpiOut.filesChanged.map(f => f.path),
      lintPassed: lint.passed,
      testsPassed: health.green,
    });

    for (const insight of silpiOut.insights) {
      await bdClient.remember(insight);
    }

    if (!health.green || !lint.passed) {
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

    throwIfAborted(signal);
    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'viharapala' });
    feedback = await runViharapala(context, silpiOut, round, context.taskDetails, branch, signal);

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
      recordProgress(kshetra); // a completed bead is forward progress (the design §3.2)
      // mergePolicy (3r2): 'pr' opens a PR and defers (bead stays open, closed on
      // merge by reconcilePullRequests); 'push' squash-merges to main + closes now.
      if (resolveMergePolicy(kshetra) === 'pr') {
        await openPrAndDefer(task, kshetra, silpiOut);
        return { approved: true, note: `Approved round ${round} — PR opened, awaiting merge` };
      }
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
  signal?: AbortSignal,
): Promise<{ approved: boolean; note: string }> {
  const bdClient = bd(kshetra);
  let round = 0;
  let feedback: ViharapalaOutput | null = null;
  let lastSilpiOut: SilpiOutput | null = null;

  emit({ type: 'task_claimed', kshetra: kshetra.id, beadId: task.id, title: task.title });
  recordProgress(kshetra); // forward progress: a repair bead claimed (the design §3.2)
  const branch = await createTaskBranch(task, kshetra);
  const guard = await captureGuard(kshetra, branch);

  // Failures on the branch before any repair work — the bar each round must beat.
  let prevFailCount = (await measureHealth(kshetra)).failCount;
  await bdClient.addNote(task.id, `Repair start: ${prevFailCount} failing`);

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;
    throwIfAborted(signal);
    emit({ type: 'round_start', kshetra: kshetra.id, beadId: task.id, round, agent: 'silpi' });

    const context = await buildAgentContext(kshetra, task);
    const silpiOut = await runSilpi(context, round, feedback, branch, signal);
    lastSilpiOut = silpiOut;
    for (const insight of silpiOut.insights) {
      await bdClient.remember(insight);
    }

    const offBranch = await guardAfterAgent(kshetra, task, guard, round);
    if (offBranch) return offBranch;

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
      recordProgress(kshetra); // suite restored to green is forward progress (the design §3.2)
      // Health-repair beads ALWAYS merge to main directly, regardless of
      // mergePolicy: they are the mechanism that restores a green base so feature
      // work can proceed, so deferring one behind a human PR gate would wedge the
      // whole queue. Only feature work honours the 'pr' policy.
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
