import type { AgentContext, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';
import type { KshetraConfig } from '../kshetra/config.js';
import {
  resolveBuildCommand,
  resolveTestCommand,
  resolveLintCommand,
  resolveCoverageCommand,
} from '../kshetra/toolchain.js';
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

// The exact commands the harness will enforce at the gate (toolchain
// single-source), injected so Silpi never iterates against a different command
// than the one that decides APPROVE/REJECT (command-drift). Empty commands are
// omitted (that gate is skipped); all empty → no section.
function qualityGateCommands(kshetra: KshetraConfig): string {
  const commands: Array<[string, string]> = [
    ['build', resolveBuildCommand(kshetra)],
    ['test', resolveTestCommand(kshetra)],
    ['lint', resolveLintCommand(kshetra)],
    ['coverage', resolveCoverageCommand(kshetra)],
  ];
  const lines = commands.filter(([, cmd]) => cmd).map(([name, cmd]) => `- ${name}: \`${cmd}\``);
  if (lines.length === 0) return '';
  return (
    `== QUALITY GATES ==\n` +
    `These are the EXACT commands the harness runs to gate your submission.\n` +
    `Run these — not variants from docs or scripts — so your local result matches the gate:\n` +
    lines.join('\n')
  );
}

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

  // Native execution (the agent-execution design §3.1): repo skills/rules, the project
  // instruction file, and the conventions docs are loaded by the provider CLI
  // itself, so we inject only the cross-project universalSkills here. The
  // conventions/architecture sections are gone for the same reason — they now
  // @-import into the instruction file the CLI loads.
  if (context.universalSkills) sections.push(`== SKILLS ==\n${context.universalSkills}`);

  if (context.projectMemory) sections.push(`== PROJECT MEMORY ==\n${context.projectMemory}`);

  sections.push(`== TASK ==\nRound: ${round}\nBranch: ${branch}\n${context.taskDetails}`);

  if (feedback?.mustFix?.length) {
    const list = feedback.mustFix.map(f => `- ${f}`).join('\n');
    sections.push(
      `== PRIOR FEEDBACK (Round ${round}) ==\n` +
        `The previous round was rejected. You MUST fix ALL of the following:\n${list}`,
    );
  }

  if (context.ragChunks) sections.push(`== RELEVANT CODE ==\n${context.ragChunks}`);

  const gateCommands = qualityGateCommands(context.kshetra);
  if (gateCommands) sections.push(gateCommands);

  sections.push(`== ROLE BOUNDARY ==
You are Silpi, the Sthapathi-dispatched implementer for this bead, running
unattended — this is NOT an interactive session. Any repository instruction
addressed to "interactive sessions" (e.g. "task producer only", "do NOT implement
tasks yourself") does NOT apply to you: implement this task with your tools.
You are a pure coding agent. Sthapathi handles all task-state and git operations EXCEPT your implementation commits.
Do NOT call \`bd\` commands. Do NOT push to remote.

== INSTRUCTIONS ==
1. Use Read to understand the existing codebase structure and patterns.
2. Implement the task fully using Write and Edit tools.
3. Write unit tests covering the new behaviour.
4. ${gateCommands ? 'Run the quality gates using Bash — the EXACT commands in == QUALITY GATES == — ALL must pass.' : "Run the project's quality gates using Bash, if it has any — ALL must pass."}
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
  signal?: AbortSignal,
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
    signal,
  });

  if (!result.structuredOutput) {
    throw new ParseError(
      `Silpi: no structured output in result — resultText: ${(result.resultText ?? '').slice(0, 200)}`,
      null,
    );
  }

  return result.structuredOutput as SilpiOutput;
}
