import { loadRegistry } from '../kshetra/registry';
import { assembleKshetraStatus } from '../kshetra/status';
import type { KshetraStatusInfo } from '../kshetra/status';
import type { KshetraConfig } from '../kshetra/config';

// The per-Kshetra status assembly lives in ../kshetra/status.ts so the CLI and
// Phalaka share one source of truth; this module owns only the CLI presentation.
export { assembleKshetraStatus } from '../kshetra/status';
export type { ActiveBead, KshetraStatusInfo } from '../kshetra/status';

// "2026-06-30T03:00:00Z" → "12m ago" / "2h ago". Empty when unknown.
export function formatAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

// The resume hint depends on WHY it paused. A reason:'stuck' pause means a live
// worker is hung on an agent; `shreni resume` now triggers an in-process
// self-heal — the worker aborts the hung agent, RECOVERs, and re-arms
// — so plain resume recovers it. If no worker is running the
// resume command itself redirects to `shreni start`. All other pause reasons
// (api_down/git_failed/bd_failed/manual) also clear with plain resume.
export function resumeHint(reason: string | undefined, kshetraId: string): string {
  if (reason === 'stuck') {
    return `Requires manual resume: shreni resume --kshetra ${kshetraId} (worker self-heals the hung agent)`;
  }
  return 'Requires manual resume: shreni resume';
}

export function formatKshetraStatus(info: KshetraStatusInfo): string {
  const lines: string[] = [];
  const daemonLabel = info.daemonRunning ? `running (pid ${info.pid})` : 'stopped';
  lines.push(`Kshetra: ${info.kshetra.name} (${info.kshetra.id}) — worker ${daemonLabel}`);
  lines.push('─'.repeat(50));

  if (info.paused) {
    const reason = info.pauseReason ? ` (${info.pauseReason})` : '';
    lines.push(`Status:  paused${reason}`);
    if (info.pauseMessage) lines.push(`         ${info.pauseMessage}`);
    if (info.requiresManualResume) lines.push(`         ${resumeHint(info.pauseReason, info.kshetra.id)}`);
  } else {
    const phase = info.phase ? ` · phase ${info.phase}` : '';
    lines.push(`Status:  active${phase}`);
  }

  // Stuck banner — the watchdog's diagnosis + remediation, surfaced prominently.
  if (info.stuck) {
    lines.push('');
    lines.push(`⚠️  STUCK (since ${formatAge(info.stuck.since)}): ${info.stuck.reason}`);
    lines.push('    Try:');
    for (const step of info.stuck.remediation.split('\n')) lines.push(`    ${step}`);
  }

  lines.push('');

  if (info.activeBead) {
    const { id, title, agent, round, followup } = info.activeBead;
    lines.push(`Active bead: ${id} · ${title}`);
    const details: string[] = [];
    if (agent) details.push(`Agent: ${agent}`);
    if (round !== undefined) details.push(`Round: ${round}`);
    if (details.length > 0) lines.push(`  ${details.join('  ')}`);
    // The open-PR follow-up loop is occupying the work slot — call it out, since a
    // plain "active bead" line would otherwise read like ordinary first-pass work.
    if (followup) {
      lines.push(`  ↳ PR follow-up: addressing open-PR feedback (round ${followup.round}/${followup.maxRounds})`);
    }
  } else {
    lines.push('Active bead: none');
  }

  lines.push('');
  lines.push(`Queue depth: ${info.queueDepth}`);

  if (info.lastCompleted) {
    lines.push(`Last completed: ${info.lastCompleted.id} · ${info.lastCompleted.title}`);
  }

  const progressAge = formatAge(info.lastProgressAt);
  if (progressAge) lines.push(`Last progress: ${progressAge}`);

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
      const info = await assembleKshetraStatus(k);
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

  const info = await assembleKshetraStatus(kshetra);
  console.log(formatKshetraStatus(info));
}