import { loadRegistry } from '../kshetra/registry';
import { getKshetraStatus, formatKshetraStatus } from './status';
import { readPid, isAlive } from './pid';
import type { KshetraConfig } from '../kshetra/config';

export interface AgentLine {
  kshetraId: string;
  kshetraName: string;
  daemonRunning: boolean;
  paused: boolean;
  beadId?: string;
  beadTitle?: string;
  agent?: string;
  round?: number;
}

export async function getAgentLines(): Promise<AgentLine[]> {
  const kshetras = loadRegistry();
  const pid = readPid();
  const daemonRunning = pid !== null && isAlive(pid);

  const lines = await Promise.all(
    kshetras.map(async (k: KshetraConfig): Promise<AgentLine> => {
      const info = await getKshetraStatus(k);
      return {
        kshetraId: k.id,
        kshetraName: k.name,
        daemonRunning,
        paused: info.paused,
        beadId: info.activeBead?.id,
        beadTitle: info.activeBead?.title,
        agent: info.activeBead?.agent,
        round: info.activeBead?.round,
      };
    }),
  );
  return lines;
}

export function formatAgentLines(lines: AgentLine[]): string {
  if (lines.length === 0) return 'No kshetras registered.';

  return lines
    .map(l => {
      const daemon = l.daemonRunning ? 'running' : 'stopped';
      const prefix = `${l.kshetraName} (${l.kshetraId}) [${daemon}]`;

      if (l.paused) return `${prefix}  paused`;
      if (!l.beadId) return `${prefix}  idle`;

      const parts: string[] = [`${l.beadId} · ${l.beadTitle}`];
      if (l.agent) parts.push(`[${l.agent}${l.round !== undefined ? `, Round ${l.round}` : ''}]`);
      return `${prefix}  ${parts.join('  ')}`;
    })
    .join('\n');
}

export async function runAgents(): Promise<void> {
  const lines = await getAgentLines();
  console.log(formatAgentLines(lines));
}