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

Use provided tools to answer questions:
- get_bead / list_beads: inspect issues and backlog
- get_agent_status: check Sthapathi paused/active state
- search_codebase: grep for code patterns
- read_file: read a file from a kshetra repo
- get_diff: inspect a branch diff

Always fetch fresh state via tools rather than guessing. Respond in clear, concise prose.`);

  return sections.join('\n\n');
}