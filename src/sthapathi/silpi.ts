import Anthropic from '@anthropic-ai/sdk';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, SilpiOutput } from './types.js';
import { bd } from './beads.js';

const SYSTEM_PROMPT = `You are Silpi, an expert coding agent. Implement the given task.

Respond with ONLY a valid JSON object — no markdown fences, no explanation — matching this exact structure:
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

confidenceScore is 0-100. You are a pure coding agent — never call the issue tracker. Sthapathi handles all coordination.`;

function buildTaskContext(task: Task, round: number): string {
  const parts: string[] = [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Priority: P${task.priority}`,
    `Round: ${round}`,
  ];
  if (task.description) parts.push(`\nDescription:\n${task.description}`);
  if (task.notes) parts.push(`\nPrior notes:\n${task.notes}`);
  if (task.context?.relatedFiles?.length) {
    parts.push(`\nRelated files:\n${task.context.relatedFiles.join('\n')}`);
  }
  return parts.join('\n');
}

export async function runSilpi(
  task: Task,
  kshetra: KshetraConfig,
  round: number,
): Promise<SilpiOutput> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: kshetra.agents.model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildTaskContext(task, round) }],
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
  await bd(kshetra).addNote(task.id, note);

  return output;
}