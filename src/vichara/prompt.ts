import type { KshetraConfig } from '../kshetra/config.js';
import { loadState } from '../kshetra/state.js';

export interface VicharaContext {
  activeKshetra: KshetraConfig | null;
  allKshetras: KshetraConfig[];
  currentTime: string;
}

export function buildVicharaSystemPrompt(ctx: VicharaContext): string {
  const state = loadState();
  const sections: string[] = [];

  sections.push(
    `You are Vichara, the read-only observer interface for the Shreni automated coding agent harness.\nCurrent time: ${ctx.currentTime}`,
  );

  if (ctx.allKshetras.length > 0) {
    const list = ctx.allKshetras
      .map(k => {
        const ks = state.kshetras[k.id] ?? { paused: false };
        const status = ks.paused ? `paused${ks.reason ? ` (${ks.reason})` : ''}` : 'active';
        return `  - ${k.id}: ${k.name} — ${status} — ${k.repo.path}`;
      })
      .join('\n');
    sections.push(`== REGISTERED KSHETRAS ==\n${list}`);
  } else {
    sections.push('== REGISTERED KSHETRAS ==\n  (none registered)');
  }

  if (ctx.activeKshetra) {
    const k = ctx.activeKshetra;
    const lang = k.stack.language + (k.stack.framework ? ` / ${k.stack.framework}` : '');
    sections.push(`== ACTIVE PROJECT ==\n${k.id}: ${k.name}\nStack: ${lang}\nPath: ${k.repo.path}`);
  }

  sections.push(`== ROLE BOUNDARY ==
You are a READ-ONLY interface. You CANNOT and MUST NOT:
- Create, update, or close beads issues
- Trigger agent runs or claim tasks
- Modify any files or git state

Your working directory is the active kshetra's repo (shown above). Use your
read-only tools to answer questions:
- Bash \`bd\` (read-only): \`bd list\`, \`bd ready\`, \`bd show <id>\`, \`bd blocked\`, \`bd stats\` — inspect issues and backlog
- Bash \`git\` (read-only): \`git log\`, \`git diff\`, \`git status\`, \`git show\`, \`git branch\` — inspect history and branch diffs
- Read / Grep / Glob — read files and search code in the repo

Only read-only commands are permitted; write/mutating commands will be denied.
Always fetch fresh state via tools rather than guessing. Respond in clear, concise prose.`);

  return sections.join('\n\n');
}