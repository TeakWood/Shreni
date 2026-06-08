import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';
import { bd } from '../sthapathi/beads.js';

function buildSilpiSystemPrompt(
  context: AgentContext,
  round: number,
  feedback?: ViharapalaOutput | null,
): string {
  const sections: string[] = [];

  sections.push(`You are Silpi, a coding agent for the ${context.kshetra.name} project.`);

  const skills = [context.universalSkills, context.projectSkills, context.scopedSkills]
    .filter(Boolean)
    .join('\n');
  if (skills) sections.push(`== SKILLS ==\n${skills}`);

  if (context.projectMemory) sections.push(`== PROJECT MEMORY ==\n${context.projectMemory}`);

  sections.push(`== TASK ==\nRound: ${round}\n${context.taskDetails}`);

  if (feedback?.mustFix?.length) {
    const list = feedback.mustFix.map(f => `- ${f}`).join('\n');
    sections.push(`== PRIOR FEEDBACK (Round ${round}) ==\nThe previous round was rejected. You MUST fix:\n${list}`);
  }

  if (context.conventions) sections.push(`== CONVENTIONS ==\n${context.conventions}`);

  if (context.architecture) sections.push(`== ARCHITECTURE ==\n${context.architecture}`);

  if (context.ragChunks) sections.push(`== RELEVANT CODE ==\n${context.ragChunks}`);

  sections.push(`== ROLE BOUNDARY ==
Your job is to write code and return a SilpiOutput JSON object.
You do NOT call bd commands or manage task state — Sthapathi handles all of that.
Any project insights you discover should go in the \`insights\` field; Sthapathi will persist them.
Do NOT call bd, git, or any shell commands outside of running lint and tests on the code you write.
You are a pure coding agent — never call the issue tracker. Sthapathi handles all coordination.

== INSTRUCTIONS ==
1. Implement the task to satisfy all acceptance criteria.
2. Write unit tests. Run lint and tests.
3. If tests fail, fix them before submitting.
4. Respond ONLY with a valid JSON SilpiOutput object — no markdown fences, no explanation:
{
  "filesChanged": [{"path": "string", "diff": "string"}],
  "testFiles": ["string"],
  "summary": "string",
  "confidenceScore": 0,
  "questionsForReviewer": ["string"],
  "lintPassed": true,
  "testsPassed": true,
  "insights": ["string"]
}
confidenceScore is 0-100.`);

  return sections.join('\n\n');
}

export async function runSilpi(
  context: AgentContext,
  round: number,
  feedback?: ViharapalaOutput | null,
): Promise<SilpiOutput> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: context.kshetra.agents.model,
    max_tokens: 16000,
    system: buildSilpiSystemPrompt(context, round, feedback),
    messages: [
      {
        role: 'user',
        content: 'Implement the task as described in the system prompt. Return ONLY a JSON SilpiOutput object.',
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Silpi: no text block in Claude response');
  }

  const output: SilpiOutput = JSON.parse(textBlock.text) as SilpiOutput;

  const note =
    `Round ${round}: confidence=${output.confidenceScore} ` +
    `lint=${output.lintPassed} tests=${output.testsPassed} — ` +
    output.summary.slice(0, 120);
  await bd(context.kshetra).addNote(context.task.id, note);

  return output;
}