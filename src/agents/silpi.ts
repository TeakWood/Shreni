import type { AgentContext, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';
import { runAgent } from './runner.js';

const SILPI_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    filesChanged: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string' },
        },
        required: ['path', 'diff'],
      },
    },
    testFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    confidenceScore: { type: 'number' },
    questionsForReviewer: { type: 'array', items: { type: 'string' } },
    lintPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    insights: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'filesChanged',
    'testFiles',
    'summary',
    'confidenceScore',
    'questionsForReviewer',
    'lintPassed',
    'testsPassed',
    'insights',
  ],
};

function buildSilpiSystemPrompt(
  context: AgentContext,
  round: number,
  branch: string,
  feedback?: ViharapalaOutput | null,
): string {
  const sections: string[] = [];

  sections.push(
    `You are Silpi, a coding agent for the ${context.kshetra.name} project.\n` +
      `You have real tools available: Bash, Read, Write, Edit. Use them to implement the task.`,
  );

  const skills = [context.universalSkills, context.projectSkills, context.scopedSkills]
    .filter(Boolean)
    .join('\n');
  if (skills) sections.push(`== SKILLS ==\n${skills}`);

  if (context.projectMemory) sections.push(`== PROJECT MEMORY ==\n${context.projectMemory}`);

  sections.push(`== TASK ==\nRound: ${round}\nBranch: ${branch}\n${context.taskDetails}`);

  if (feedback?.mustFix?.length) {
    const list = feedback.mustFix.map(f => `- ${f}`).join('\n');
    sections.push(
      `== PRIOR FEEDBACK (Round ${round}) ==\n` +
        `The previous round was rejected. You MUST fix ALL of the following:\n${list}`,
    );
  }

  if (context.conventions) sections.push(`== CONVENTIONS ==\n${context.conventions}`);
  if (context.architecture) sections.push(`== ARCHITECTURE ==\n${context.architecture}`);
  if (context.ragChunks) sections.push(`== RELEVANT CODE ==\n${context.ragChunks}`);

  sections.push(`== ROLE BOUNDARY ==
You are a pure coding agent. Sthapathi handles all task-state and git operations EXCEPT your implementation commits.
Do NOT call \`bd\` commands. Do NOT push to remote.

== INSTRUCTIONS ==
1. Use Read to understand the existing codebase structure and patterns.
2. Implement the task fully using Write and Edit tools.
3. Write unit tests covering the new behaviour.
4. Run the project's quality gates (check CLAUDE.md for commands) using Bash — ALL must pass.
5. If tests or lint fail, fix them before proceeding.
6. Commit all changes: \`git add -A && git commit -m "${context.task.id}: <brief description>"\`
7. Get the diff of your commit: \`git show --stat HEAD && git diff HEAD~1 HEAD\`
8. After completing all work, your FINAL response MUST be ONLY a valid JSON SilpiOutput object.
   — No markdown fences, no explanation, no other text.
   — Use the git diff output to populate \`filesChanged[].diff\`.
   — Set \`lintPassed\` and \`testsPassed\` based on what actually happened when you ran them.
   — \`confidenceScore\` is 0-100.`);

  return sections.join('\n\n');
}

export async function runSilpi(
  context: AgentContext,
  round: number,
  feedback?: ViharapalaOutput | null,
  branch = `bead-${context.task.id}/${context.task.slug}`,
): Promise<SilpiOutput> {
  const result = await runAgent({
    provider: context.kshetra.agents.provider,
    systemPrompt: buildSilpiSystemPrompt(context, round, branch, feedback),
    userPrompt: `Implement task ${context.task.id}: ${context.task.title}. You are on branch ${branch}. Use your tools to implement, test, lint, and commit.`,
    cwd: context.kshetra.repo.path,
    agentName: 'silpi',
    kshetraId: context.kshetra.id,
    beadId: context.task.id,
    model: context.kshetra.agents.model,
    jsonSchema: SILPI_OUTPUT_SCHEMA,
  });

  if (!result.structuredOutput) {
    throw new ParseError(
      `Silpi: no structured output in result — resultText: ${(result.resultText ?? '').slice(0, 200)}`,
      null,
    );
  }

  return result.structuredOutput as SilpiOutput;
}
