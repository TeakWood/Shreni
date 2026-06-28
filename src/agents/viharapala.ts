import type { AgentContext, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';
import { runClaudeAgent } from './runner.js';

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

  sections.push(
    `You are Viharapala, the code reviewer for the ${context.kshetra.name} project.\n` +
      `You have real tools available: Bash, Read. Use them to review the actual code.`,
  );

  const skills = [context.universalSkills, context.projectSkills, context.scopedSkills]
    .filter(Boolean)
    .join('\n');
  if (skills) sections.push(`== SKILLS ==\n${skills}`);

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

  sections.push(`== ROLE BOUNDARY ==
You are a pure reviewer. Do NOT call bd commands. Do NOT commit or push. Sthapathi handles that.
Minor style issues do NOT block approval. Only raise REJECT for genuine blockers.

== INSTRUCTIONS ==
1. Use Read to read the changed files (check Silpi's summary for which files changed on branch ${branch}).
2. Use Bash to run the test suite and verify tests pass.
3. Use Bash to check git diff: \`git diff main...${branch}\`
4. Evaluate against all acceptance criteria in the task.
5. After your review, your FINAL response MUST be ONLY a valid JSON ViharapalaOutput object.
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
): Promise<ViharapalaOutput> {
  const result = await runClaudeAgent({
    systemPrompt: buildViharapalaSystemPrompt(context, silpiOut, round, roundHistory, branch),
    userPrompt: `Review the implementation on branch ${branch} for task ${context.task.id}: ${context.task.title}.`,
    cwd: context.kshetra.repo.path,
    agentName: 'viharapala',
    kshetraId: context.kshetra.id,
    beadId: context.task.id,
    model: context.kshetra.agents.model,
    jsonSchema: VIHARAPALA_OUTPUT_SCHEMA,
  });

  if (!result.structuredOutput) {
    throw new ParseError(
      `Viharapala: no structured output in result — resultText: ${(result.resultText ?? '').slice(0, 200)}`,
      null,
    );
  }

  return result.structuredOutput as ViharapalaOutput;
}
