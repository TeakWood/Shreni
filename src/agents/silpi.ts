import type { AgentContext, SilpiOutput, ViharapalaOutput, PrReviewFeedback } from '../sthapathi/types.js';
import type { PrReview } from '../sthapathi/gh.js';
import type { KshetraConfig } from '../kshetra/config.js';
import {
  resolveBuildCommand,
  resolveTestCommand,
  resolveLintCommand,
  resolveCoverageCommand,
} from '../kshetra/toolchain.js';
import { ParseError } from '../sthapathi/errors.js';
import { resolveExecutorMcp } from '../kshetra/mcp-connect.js';
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
    // PR follow-up only (epic hjw). Optional — an ordinary round omits it and
    // still validates; a follow-up round returns one entry per inline comment.
    commentResponses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          commentId: { type: 'string' },
          disposition: { type: 'string', enum: ['change', 'reply', 'escalate'] },
          reply: { type: 'string' },
        },
        required: ['commentId', 'disposition', 'reply'],
      },
    },
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

// Adapt a gh PR review (+ the loop's failing-check names/summaries) into the
// PrReviewFeedback shape Silpi consumes on a follow-up round (ARD §4.4). Inline
// comments get a stable `c<n>` id Silpi echoes back in commentResponses so
// Sthapathi can correlate each disposition/reply with its comment.
export function adaptPrReview(
  review: PrReview,
  failingChecks: { name: string; summary: string }[] = [],
): PrReviewFeedback {
  return {
    reviewBody: review.body,
    comments: review.comments.map((c, i) => ({
      id: `c${i}`,
      author: c.author,
      path: c.path,
      line: c.line,
      body: c.body,
    })),
    failingChecks,
  };
}

// The PR follow-up prompt section (ARD §4.4): the human reviewer plays
// Viharapala's part, so Silpi addresses the review in two ways — code edits (which
// surface in filesChanged as usual) AND a per-comment triage returned in
// commentResponses. Rendered only when a follow-up round supplies prFeedback.
function prFollowupSection(prFeedback: PrReviewFeedback): string {
  const lines: string[] = [
    `== PR REVIEW FEEDBACK (follow-up round) ==`,
    `A human reviewer requested changes on the OPEN pull request for this bead.`,
    `The reviewer is playing the code-reviewer's part — address the review in TWO ways:`,
    `1. CODE — for each point that needs a code change, make the edit; it appears in filesChanged as usual.`,
    `2. TRIAGE — return \`commentResponses\`, ONE entry per inline comment listed below, each with:`,
    `   - commentId: the id in [brackets]`,
    `   - disposition: "change" (you edited code to address it), "reply" (you answered without a code change), or "escalate" (a human must decide)`,
    `   - reply: the draft reply Sthapathi will POST on the PR (for "change", a brief note of what you changed; for "escalate", why a human is needed). Do NOT resolve the thread — only reply.`,
  ];
  if (prFeedback.reviewBody.trim()) {
    lines.push('', `Reviewer summary:`, prFeedback.reviewBody.trim());
  }
  if (prFeedback.comments.length) {
    lines.push('', `Inline comments to triage:`);
    for (const c of prFeedback.comments) {
      const loc = c.path ? `${c.path}${c.line != null ? `:${c.line}` : ''}` : 'general';
      lines.push(`- [${c.id}] ${loc}${c.author ? ` (@${c.author})` : ''} — ${c.body}`);
    }
  }
  if (prFeedback.failingChecks.length) {
    lines.push('', `Failing required checks (fix the underlying cause; detail from the local health gate):`);
    for (const chk of prFeedback.failingChecks) {
      lines.push(`- ${chk.name}: ${chk.summary}`);
    }
  }
  return lines.join('\n');
}

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
  prFeedback?: PrReviewFeedback | null,
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

  if (prFeedback) sections.push(prFollowupSection(prFeedback));

  if (context.repoMap) sections.push(`== REPO MAP ==\n${context.repoMap}`);

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
  // PR follow-up round (epic hjw): the adapted human review. When set, Silpi's
  // prompt carries the triage instructions and its output includes
  // commentResponses. Trailing/optional so ordinary callers are unaffected.
  prFeedback?: PrReviewFeedback | null,
): Promise<SilpiOutput> {
  const result = await runAgent({
    provider: context.kshetra.agents.provider,
    systemPrompt: buildSilpiSystemPrompt(context, round, branch, feedback, prFeedback),
    userPrompt: `Implement task ${context.task.id}: ${context.task.title}. You are on branch ${branch}. Use your tools to implement, test, lint, and commit.`,
    cwd: context.kshetra.repo.path,
    agentName: 'silpi',
    kshetraId: context.kshetra.id,
    beadId: context.task.id,
    model: context.kshetra.agents.model,
    jsonSchema: SILPI_OUTPUT_SCHEMA,
    mcp: resolveExecutorMcp(context.kshetra, 'silpi'),
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
