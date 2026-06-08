import Anthropic from '@anthropic-ai/sdk';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, E2EOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';

export interface E2EContext {
  kshetra: KshetraConfig;
  task: Task;
  mergedDiff: string;
  existingTestFiles: string[];
  personas?: string;
}

export function buildE2ESystemPrompt(ctx: E2EContext): string {
  const sections: string[] = [];

  sections.push(`You are an E2E testing agent for the ${ctx.kshetra.name} project.`);

  if (ctx.personas) sections.push(`== PERSONAS ==\n${ctx.personas}`);

  const testList = ctx.existingTestFiles.length
    ? ctx.existingTestFiles.join('\n')
    : '(none)';
  sections.push(`== EXISTING TEST FILES ==\n${testList}`);

  sections.push(`== MERGED DIFF ==\n${ctx.mergedDiff || '(empty diff)'}`);

  sections.push(`== TASK ==\n${ctx.task.id}: ${ctx.task.title}`);

  sections.push(`== ROLE BOUNDARY ==
You are a pure E2E test author — write test files and identify coverage gaps.
Do NOT call bd, git, or any other commands. Sthapathi handles all coordination.
Do not implement features, only write tests.

== INSTRUCTIONS ==
1. Analyse the merged diff and existing test files.
2. Write any new E2E test files needed to cover the merged changes.
3. Identify coverage gaps that need further tasks.
4. Respond ONLY with a valid JSON E2EOutput object — no markdown fences, no explanation:
{
  "testFilesAdded": ["path/to/test1.ts"],
  "coverageGaps": [
    { "feature": "string", "description": "string", "priority": 1 }
  ]
}
priority is 0-4 (0=critical, 4=backlog).`);

  return sections.join('\n\n');
}

export async function runE2E(ctx: E2EContext): Promise<E2EOutput> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: ctx.kshetra.agents.model,
    max_tokens: 8000,
    system: buildE2ESystemPrompt(ctx),
    messages: [
      {
        role: 'user',
        content: 'Analyse the diff and write E2E tests. Return ONLY a JSON E2EOutput object.',
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('E2E agent: no text block in Claude response');
  }

  let output: E2EOutput;
  try {
    output = JSON.parse(textBlock.text) as E2EOutput;
  } catch (err) {
    throw new ParseError(`E2E agent: invalid JSON — ${(err as Error).message}`, err);
  }

  return output;
}