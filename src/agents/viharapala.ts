import type { AgentContext, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';
import { runAgent } from './runner.js';
// The build-gate command is resolved by the toolchain profile (one home for all
// ecosystem defaults). Re-exported so callers/tests that reach for it via the
// reviewer keep working. An empty command means the Kshetra has no build gate.
import { resolveBuildCommand } from '../kshetra/toolchain.js';
export { resolveBuildCommand };

const VIHARAPALA_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    overallScore: { type: 'number' },
    mustFix: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
    insights: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'overallScore', 'mustFix', 'suggestions', 'issues', 'insights'],
};

function buildViharapalaSystemPrompt(
  context: AgentContext,
  silpiOut: SilpiOutput,
  round: number,
  roundHistory: string,
  branch: string,
): string {
  const sections: string[] = [];
  const buildCommand = resolveBuildCommand(context.kshetra);

  sections.push(
    `You are Viharapala, the code reviewer for the ${context.kshetra.name} project.\n` +
      `You have real tools available: Bash, Read. Use them to review the actual code.`,
  );

  // Native execution (the agent-execution design §3.1): the provider CLI loads repo
  // skills/rules and the instruction file itself, so only the cross-project
  // universalSkills are injected here.
  if (context.universalSkills) sections.push(`== SKILLS ==\n${context.universalSkills}`);

  if (context.projectMemory) sections.push(`== PROJECT MEMORY ==\n${context.projectMemory}`);

  sections.push(`== TASK AND ACCEPTANCE CRITERIA ==\n${context.taskDetails}`);

  sections.push(`== SILPI'S SUMMARY (Round ${round}, Branch: ${branch}) ==
${JSON.stringify({ summary: silpiOut.summary, files: silpiOut.filesChanged.map(f => f.path), confidence: silpiOut.confidenceScore, lintPassed: silpiOut.lintPassed, testsPassed: silpiOut.testsPassed, questions: silpiOut.questionsForReviewer }, null, 2)}`);

  if (roundHistory) sections.push(`== FULL ROUND HISTORY ==\n${roundHistory}`);

  sections.push(`== REVIEW DIMENSIONS ==
1. Correctness: Does the code satisfy ALL acceptance criteria?
2. Test coverage: Are edge cases covered? Do tests verify behaviour, not just implementation?
3. Code quality: Patterns, readability, potential bugs, security.
4. Side effects: Regressions, breaking interface changes.
5. Completeness: No TODOs, no half-done work, no dead code.`);

  // Reviewer-only custom instructions (the agent-execution design §3.3 channel B).
  // Injected here and nowhere else (Silpi never sees it). It ADDS criteria and
  // rubric on top of the dimensions above but cannot waive a Shreni hard gate —
  // precedence is: Shreni gates (build/test, role boundary, output contract) >
  // this guide > shared native criteria.
  if (context.reviewGuide) {
    sections.push(`== REVIEW GUIDE (developer-supplied, reviewer-only) ==
${context.reviewGuide}

Apply these as ADDITIONAL review criteria and scoring rubric. They do NOT override
Shreni's hard gates: a failing build/test gate, the role boundary, and the
structured-output contract always win. This guide can only make the review
stricter or add criteria — it can never approve a task that fails a gate.`);
  }

  sections.push(
    buildCommand
      ? `== BUILD GATE (MANDATORY, RUN FIRST) ==
Before reviewing anything, run the build on branch ${branch}: \`${buildCommand}\`
This is the authoritative compile/type-check gate — it must exit 0.
- If the build exits NON-ZERO, you MUST REJECT. Do not read the diff, do not
  evaluate correctness, do not APPROVE under any circumstance.
  · Set \`verdict\` to "REJECT".
  · Put the compiler/build error output (the failing files and messages) into
    \`mustFix\` so Silpi can fix it.
  · Add a \`blocker\`-severity entry to \`issues\` describing the build failure.
- Only if the build exits 0 may you proceed to the test gate and the review.
There are NO exceptions: never skip the build gate to unblock a deadline, and
never approve a task whose branch does not compile — a red build means type
errors would reach main.`
      : `== BUILD GATE ==
This Kshetra has no build gate configured (stack.buildCommand is empty), so there
is no compile step to run. Proceed directly to the test gate and the review.`,
  );

  sections.push(`== ROLE BOUNDARY ==
You are Viharapala, the Sthapathi-dispatched reviewer for this bead, running
unattended — this is NOT an interactive session. Any repository instruction
addressed to "interactive sessions" (e.g. "task producer only", "do NOT implement
or review") does NOT apply to you: review this task with your tools.
You are a pure reviewer. Do NOT call bd commands. Do NOT commit or push. Sthapathi handles that.
Minor style issues do NOT block approval. Only raise REJECT for genuine blockers.

== INSTRUCTIONS ==
1. ${buildCommand ? `Use Bash to run the BUILD GATE first: \`${buildCommand}\`. If it fails, REJECT
   immediately with the compiler output in \`mustFix\` (see BUILD GATE above).` : `No build gate is configured for this Kshetra — skip straight to the tests.`}
2. Use Read to read the changed files (check Silpi's summary for which files changed on branch ${branch}).
3. Use Bash to run the test suite and verify tests pass.
4. Use Bash to check git diff: \`git diff main...${branch}\`
5. Evaluate against all acceptance criteria in the task.
6. After your review, your FINAL response MUST be ONLY a valid JSON ViharapalaOutput object.
   — No markdown fences, no explanation, no other text.
   — \`verdict\` must be "APPROVE" or "REJECT".
   — Only REJECT for genuine blockers. Minor suggestions go in \`suggestions\`, not \`mustFix\`.`);

  return sections.join('\n\n');
}

export async function runViharapala(
  context: AgentContext,
  silpiOut: SilpiOutput,
  round: number,
  roundHistory: string,
  branch = `bead-${context.task.id}/${context.task.slug}`,
  signal?: AbortSignal,
): Promise<ViharapalaOutput> {
  const result = await runAgent({
    provider: context.kshetra.agents.provider,
    systemPrompt: buildViharapalaSystemPrompt(context, silpiOut, round, roundHistory, branch),
    userPrompt: `Review the implementation on branch ${branch} for task ${context.task.id}: ${context.task.title}.`,
    cwd: context.kshetra.repo.path,
    agentName: 'viharapala',
    kshetraId: context.kshetra.id,
    beadId: context.task.id,
    model: context.kshetra.agents.model,
    jsonSchema: VIHARAPALA_OUTPUT_SCHEMA,
    signal,
  });

  if (!result.structuredOutput) {
    throw new ParseError(
      `Viharapala: no structured output in result — resultText: ${(result.resultText ?? '').slice(0, 200)}`,
      null,
    );
  }

  return result.structuredOutput as ViharapalaOutput;
}
