import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';

function buildViharapalaSystemPrompt(
  context: AgentContext,
  silpiOut: SilpiOutput,
  round: number,
  roundHistory: string,
): string {
  const sections: string[] = [];

  sections.push(`You are Viharapala, a code reviewer for the ${context.kshetra.name} project.`);

  const skills = [context.universalSkills, context.projectSkills, context.scopedSkills]
    .filter(Boolean)
    .join('\n');
  if (skills) sections.push(`== SKILLS ==\n${skills}`);

  if (context.projectMemory) sections.push(`== PROJECT MEMORY ==\n${context.projectMemory}`);

  sections.push(`== TASK AND ACCEPTANCE CRITERIA ==\n${context.taskDetails}`);

  sections.push(`== SILPI'S OUTPUT (Round ${round}) ==\n${JSON.stringify(silpiOut, null, 2)}`);

  if (roundHistory) sections.push(`== FULL ROUND HISTORY ==\n${roundHistory}`);

  sections.push(`== REVIEW DIMENSIONS ==
1. Correctness: Does code satisfy all acceptance criteria?
2. Test coverage: Are edge cases covered? Do tests test behavior?
3. Code quality: Patterns, readability, potential bugs, security.
4. Side effects: Regressions, breaking interface changes.
5. Completeness: No TODOs, no half-done work.`);

  sections.push(`== ROLE BOUNDARY ==
Your job is to review code and return a ViharapalaOutput JSON object.
You do NOT call bd commands or manage task state — Sthapathi handles all of that.
Any project insights you discover should go in the \`insights\` field; Sthapathi will persist them.
Minor issues do not block approval. Only raise REJECT for blockers.

Respond ONLY with a valid JSON ViharapalaOutput object — no markdown fences, no explanation:
{
  "verdict": "APPROVE",
  "overallScore": 0,
  "mustFix": ["string"],
  "suggestions": ["string"],
  "issues": [{"severity": "blocker|major|minor", "file": "string", "description": "string"}],
  "insights": ["string"]
}
verdict must be "APPROVE" or "REJECT".`);

  return sections.join('\n\n');
}

export async function runViharapala(
  context: AgentContext,
  silpiOut: SilpiOutput,
  round: number,
  roundHistory: string,
): Promise<ViharapalaOutput> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: context.kshetra.agents.model,
    max_tokens: 8000,
    system: buildViharapalaSystemPrompt(context, silpiOut, round, roundHistory),
    messages: [
      {
        role: 'user',
        content: "Review Silpi's output as described in the system prompt. Return ONLY a JSON ViharapalaOutput object.",
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Viharapala: no text block in Claude response');
  }

  return JSON.parse(textBlock.text) as ViharapalaOutput;
}