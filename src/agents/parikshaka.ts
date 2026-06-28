import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, ParikshakaOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';
import { runClaudeAgent } from './runner.js';

export interface ParikshakaContext {
  kshetra: KshetraConfig;
  task: Task;
  mergedDiff: string;
  existingTestFiles: string[];
  personas?: string;
}

const PARIKSHAKA_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    testFilesAdded: { type: 'array', items: { type: 'string' } },
    coverageGaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feature: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['feature', 'description', 'priority'],
      },
    },
  },
  required: ['testFilesAdded', 'coverageGaps'],
};

function buildParikshakaSystemPrompt(ctx: ParikshakaContext): string {
  const sections: string[] = [];

  sections.push(
    `You are Parikshaka, the test agent for the ${ctx.kshetra.name} project.\n` +
      `You have real tools available: Bash, Read, Write, Edit. Use them to write test files.`,
  );

  if (ctx.personas) sections.push(`== PERSONAS ==\n${ctx.personas}`);

  const testList = ctx.existingTestFiles.length ? ctx.existingTestFiles.join('\n') : '(none)';
  sections.push(`== EXISTING TEST FILES ==\n${testList}`);

  sections.push(`== MERGED DIFF ==\n${ctx.mergedDiff || '(empty diff)'}`);

  sections.push(`== TASK ==\n${ctx.task.id}: ${ctx.task.title}`);

  sections.push(`== ROLE BOUNDARY ==
You are a pure test author. Do NOT call bd commands. Do NOT commit or push. Sthapathi handles that.
Do NOT implement features — only write tests.

== INSTRUCTIONS ==
1. Use Read to understand the existing codebase and test patterns.
2. Analyse the merged diff to understand what changed.
3. Write any new test files needed using Write or Edit tools.
4. Use Bash to run the tests and verify they pass.
5. Identify any coverage gaps that need separate tasks.
6. After completing all work, your FINAL response MUST be ONLY a valid JSON ParikshakaOutput object.
   — No markdown fences, no explanation, no other text.
   — List test files you added/modified in \`testFilesAdded\`.
   — \`coverageGaps[].priority\` is 0-4 (0=critical, 4=backlog).`);

  return sections.join('\n\n');
}

export async function runParikshaka(ctx: ParikshakaContext): Promise<ParikshakaOutput> {
  const result = await runClaudeAgent({
    systemPrompt: buildParikshakaSystemPrompt(ctx),
    userPrompt: `Analyse the merged diff and write e2e / user-persona tests for task ${ctx.task.id}: ${ctx.task.title}.`,
    cwd: ctx.kshetra.repo.path,
    agentName: 'parikshaka',
    kshetraId: ctx.kshetra.id,
    beadId: ctx.task.id,
    model: ctx.kshetra.agents.model,
    jsonSchema: PARIKSHAKA_OUTPUT_SCHEMA,
  });

  if (!result.structuredOutput) {
    throw new ParseError(
      `Parikshaka: no structured output — resultText: ${(result.resultText ?? '').slice(0, 200)}`,
      null,
    );
  }

  return result.structuredOutput as ParikshakaOutput;
}
