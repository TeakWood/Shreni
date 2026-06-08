import { z } from 'zod';
import { loadRegistry } from '../kshetra/registry';
import { loadState } from '../kshetra/state';
import { bd } from '../sthapathi/beads';
import { readPid, isAlive } from './pid';
import type { KshetraConfig } from '../kshetra/config';

export interface ActiveBead {
  id: string;
  title: string;
  agent?: string;
  round?: number;
}

export interface KshetraStatusInfo {
  kshetra: KshetraConfig;
  daemonRunning: boolean;
  paused: boolean;
  pauseReason?: string;
  pauseMessage?: string;
  requiresManualResume?: boolean;
  activeBead?: ActiveBead;
  queueDepth: number;
  lastCompleted?: { id: string; title: string };
}

const BeadsItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().optional(),
  notes: z.string().optional(),
});

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseAgentRound(notes: string | undefined): { agent?: string; round?: number } {
  if (!notes) return {};
  const lines = notes.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const dispatch = line.match(/Round\s+(\d+):\s+dispatching\s+(\w+)/i);
    if (dispatch) {
      return { round: parseInt(dispatch[1], 10), agent: dispatch[2] };
    }
    const roundOnly = line.match(/Round\s+(\d+):/i);
    if (roundOnly) {
      return { round: parseInt(roundOnly[1], 10) };
    }
  }
  return {};
}

export async function getKshetraStatus(kshetra: KshetraConfig): Promise<KshetraStatusInfo> {
  const pid = readPid();
  const daemonRunning = pid !== null && isAlive(pid);

  const state = loadState();
  const ks = state.kshetras[kshetra.id];
  const paused = ks?.paused ?? false;

  const bdClient = bd(kshetra);

  const [inProgressRaw, readyRaw, closedRaw] = await Promise.all([
    bdClient.list({ status: 'in_progress' }).catch(() => '[]'),
    bdClient.ready().catch(() => '[]'),
    bdClient.list({ status: 'closed' }).catch(() => '[]'),
  ]);

  let activeBead: ActiveBead | undefined;
  const inProgress = parseJsonArray(inProgressRaw);
  if (inProgress.length > 0) {
    const parsed = BeadsItemSchema.safeParse(inProgress[0]);
    if (parsed.success) {
      const { agent, round } = parseAgentRound(parsed.data.notes);
      activeBead = { id: parsed.data.id, title: parsed.data.title, agent, round };
    }
  }

  const queueDepth = parseJsonArray(readyRaw).length;

  let lastCompleted: { id: string; title: string } | undefined;
  const closed = parseJsonArray(closedRaw);
  if (closed.length > 0) {
    const parsed = BeadsItemSchema.safeParse(closed[closed.length - 1]);
    if (parsed.success) {
      lastCompleted = { id: parsed.data.id, title: parsed.data.title };
    }
  }

  return {
    kshetra,
    daemonRunning,
    paused,
    pauseReason: ks?.reason,
    pauseMessage: ks?.message,
    requiresManualResume: ks?.requiresManualResume,
    activeBead,
    queueDepth,
    lastCompleted,
  };
}

export function resolveKshetra(kshetras: KshetraConfig[], cwd: string): KshetraConfig | null {
  let best: KshetraConfig | null = null;
  let bestLen = -1;
  for (const k of kshetras) {
    const prefix = k.repo.path.replace(/\/?$/, '/');
    if ((cwd + '/').startsWith(prefix) && prefix.length > bestLen) {
      best = k;
      bestLen = prefix.length;
    }
  }
  return best;
}

export function formatKshetraStatus(info: KshetraStatusInfo): string {
  const lines: string[] = [];
  const daemonLabel = info.daemonRunning ? 'running' : 'stopped';
  lines.push(`Kshetra: ${info.kshetra.name} (${info.kshetra.id}) — daemon ${daemonLabel}`);
  lines.push('─'.repeat(50));

  if (info.paused) {
    const reason = info.pauseReason ? ` (${info.pauseReason})` : '';
    lines.push(`Status:  paused${reason}`);
    if (info.pauseMessage) lines.push(`         ${info.pauseMessage}`);
    if (info.requiresManualResume) lines.push('         Requires manual resume: shreni resume');
  } else {
    lines.push('Status:  active');
  }

  lines.push('');

  if (info.activeBead) {
    const { id, title, agent, round } = info.activeBead;
    lines.push(`Active bead: ${id} · ${title}`);
    const details: string[] = [];
    if (agent) details.push(`Agent: ${agent}`);
    if (round !== undefined) details.push(`Round: ${round}`);
    if (details.length > 0) lines.push(`  ${details.join('  ')}`);
  } else {
    lines.push('Active bead: none');
  }

  lines.push('');
  lines.push(`Queue depth: ${info.queueDepth}`);

  if (info.lastCompleted) {
    lines.push(`Last completed: ${info.lastCompleted.id} · ${info.lastCompleted.title}`);
  }

  return lines.join('\n');
}

export async function runStatus(opts: { all: boolean; cwd: string }): Promise<void> {
  const kshetras = loadRegistry();

  if (kshetras.length === 0) {
    console.log('No kshetras registered. Run `shreni register` first.');
    return;
  }

  if (opts.all) {
    for (const k of kshetras) {
      const info = await getKshetraStatus(k);
      console.log(formatKshetraStatus(info));
      console.log();
    }
    return;
  }

  const kshetra = resolveKshetra(kshetras, opts.cwd);
  if (!kshetra) {
    console.error(`No kshetra found for cwd: ${opts.cwd}`);
    console.error('Hint: run `shreni status --all` to see all kshetras');
    process.exit(1);
    return;
  }

  const info = await getKshetraStatus(kshetra);
  console.log(formatKshetraStatus(info));
}