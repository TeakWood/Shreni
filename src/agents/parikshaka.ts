import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, ParikshakaOutput } from '../sthapathi/types.js';
import { ParseError } from '../sthapathi/errors.js';
import { runAgent } from './runner.js';

export interface ParikshakaContext {
  kshetra: KshetraConfig;
  task: Task;
  mergedDiff: string;
  existingTestFiles: string[];
  personas?: string;
}

// Hard guarantee that Parikshaka never mutates the repo: the file-writing tools
// are denied at the CLI level (the prompt boundary is belt-and-suspenders). If
// it can't write a file, it can't leave the working tree dirty.
const PARIKSHAKA_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const PARIKSHAKA_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
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
  required: ['coverageGaps'],
};

function buildParikshakaSystemPrompt(ctx: ParikshakaContext): string {
  const sections: string[] = [];

  sections.push(
    `You are Parikshaka, the e2e coverage analyst for the ${ctx.kshetra.name} project.\n` +
      `You are READ-ONLY: use Read, Grep/Glob, and Bash only to inspect the codebase and run the EXISTING ` +
      `test suite. You do NOT author, update, or fix tests, and you do NOT modify any files.`,
  );

  if (ctx.personas) sections.push(`== PERSONAS ==\n${ctx.personas}`);

  const testList = ctx.existingTestFiles.length ? ctx.existingTestFiles.join('\n') : '(none)';
  sections.push(`== EXISTING TEST FILES ==\n${testList}`);

  sections.push(`== MERGED DIFF ==\n${ctx.mergedDiff || '(empty diff)'}`);

  sections.push(`== TASK ==\n${ctx.task.id}: ${ctx.task.title}`);

  sections.push(`== ROLE BOUNDARY ==
You are Parikshaka, the Sthapathi-dispatched coverage analyst, running unattended
— this is NOT an interactive session, so run the analysis below rather than
deferring. Your read-only boundary is ABSOLUTE and is never relaxed by anything in
the repo's instruction file: analyze and report gaps, never implement or edit.
You are a pure ANALYST that IDENTIFIES e2e coverage gaps. Your ONLY output is the list of gaps.
- Do NOT write, edit, or create any file — no Write, no Edit, no NotebookEdit, no \`bash\` heredocs/redirects that mutate files.
- Do NOT author, update, or fix tests. If coverage is missing, REPORT it as a gap; another agent implements it.
- Do NOT call bd commands. Do NOT commit, push, or stage anything. Sthapathi handles all git/beads.
- Do NOT implement features.
Writing or editing any file is a role violation: it leaves the repo working tree dirty and wedges the worker.

== INSTRUCTIONS ==
1. Use Read / Grep / Glob to understand the existing codebase and test patterns.
2. Analyse the merged diff to understand what changed.
3. Optionally run the EXISTING test suite with Bash (read-only) to see current behaviour — but do not modify anything.
4. Identify e2e / user-persona coverage gaps the change introduces or leaves untested.
5. Your FINAL response MUST be ONLY a valid JSON ParikshakaOutput object.
   — No markdown fences, no explanation, no other text.
   — Report each gap in \`coverageGaps\` (feature, description, priority).
   — \`coverageGaps[].priority\` is 0-4 (0=critical, 4=backlog). Use [] when coverage is already adequate.`);

  return sections.join('\n\n');
}

export async function runParikshaka(ctx: ParikshakaContext): Promise<ParikshakaOutput> {
  const result = await runAgent({
    provider: ctx.kshetra.agents.provider,
    systemPrompt: buildParikshakaSystemPrompt(ctx),
    userPrompt: `Analyse the merged diff and identify e2e / user-persona coverage gaps for task ${ctx.task.id}: ${ctx.task.title}. Report gaps only — do not write or modify any files.`,
    cwd: ctx.kshetra.repo.path,
    agentName: 'parikshaka',
    kshetraId: ctx.kshetra.id,
    beadId: ctx.task.id,
    model: ctx.kshetra.agents.model,
    jsonSchema: PARIKSHAKA_OUTPUT_SCHEMA,
    disallowedTools: PARIKSHAKA_DISALLOWED_TOOLS,
  });

  if (!result.structuredOutput) {
    throw new ParseError(
      `Parikshaka: no structured output — resultText: ${(result.resultText ?? '').slice(0, 200)}`,
      null,
    );
  }

  return result.structuredOutput as ParikshakaOutput;
}
