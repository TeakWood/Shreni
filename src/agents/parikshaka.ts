import Anthropic from '@anthropic-ai/sdk';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, ParikshakaOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';

export interface ParikshakaContext {
  kshetra: KshetraConfig;
  task: Task;
  mergedDiff: string;
  existingTestFiles: string[];
  personas?: string;
}

export function buildParikshakaSystemPrompt(ctx: ParikshakaContext): string {
  const sections: string[] = [];

  sections.push(`You are Parikshaka, the test agent for the ${ctx.kshetra.name} project.`);

  if (ctx.personas) sections.push(`== PERSONAS ==\n${ctx.personas}`);

  const testList = ctx.existingTestFiles.length
    ? ctx.existingTestFiles.join('\n')
    : '(none)';
  sections.push(`== EXISTING TEST FILES ==\n${testList}`);

  sections.push(`== MERGED DIFF ==\n${ctx.mergedDiff || '(empty diff)'}`);

  sections.push(`== TASK ==\n${ctx.task.id}: ${ctx.task.title}`);

  sections.push(`== ROLE BOUNDARY ==
You are a pure test author — write test files and identify coverage gaps.
Do NOT call bd, git, or any other commands. Sthapathi handles all coordination.
Do not implement features, only write tests.

== INSTRUCTIONS ==
1. Analyse the merged diff and existing test files.
2. Write any new test files needed to cover the merged changes.
3. Identify coverage gaps that need further tasks.
4. Respond ONLY with a valid JSON ParikshakaOutput object — no markdown fences, no explanation:
{
  "testFilesAdded": ["path/to/test1.ts"],
  "coverageGaps": [
    { "feature": "string", "description": "string", "priority": 1 }
  ]
}
priority is 0-4 (0=critical, 4=backlog).`);

  return sections.join('\n\n');
}

export async function runParikshaka(ctx: ParikshakaContext): Promise<ParikshakaOutput> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: ctx.kshetra.agents.model,
    max_tokens: 8000,
    system: buildParikshakaSystemPrompt(ctx),
    messages: [
      {
        role: 'user',
        content: 'Analyse the diff and write tests. Return ONLY a JSON ParikshakaOutput object.',
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Parikshaka: no text block in Claude response');
  }

  let output: ParikshakaOutput;
  try {
    output = JSON.parse(textBlock.text) as ParikshakaOutput;
  } catch (err) {
    throw new ParseError(`Parikshaka: invalid JSON — ${(err as Error).message}`, err);
  }

  return output;
}