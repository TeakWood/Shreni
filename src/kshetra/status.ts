import { z } from 'zod';
import { loadState } from './state.js';
import { bd } from '../sthapathi/beads.js';
import { PR_NEEDS_FOLLOWUP_LABEL, parseWatermark } from '../sthapathi/pr-followup.js';
import { readPid, isAlive } from '../cli/pid.js';
import type { KshetraConfig } from './config.js';

// Shared per-Kshetra status assembly. Extracted from cli/status.ts so both the
// CLI (`shreni status`) and Phalaka (the control plane) read one source of truth
// and cannot drift. Formatting stays in cli/status.ts; this module produces only
// the structured KshetraStatusInfo. See docs/ard/Shreni-ARD-Control-Plane.md §4.2.

export interface ActiveBead {
  id: string;
  title: string;
  agent?: string;
  round?: number;
  // Present only when the active bead is in an open-PR follow-up pass (carries the
  // `pr-needs-followup` label). `round` is the follow-up round already spent for
  // the current feedback event (watermark), `maxRounds` the per-event budget.
  followup?: { round: number; maxRounds: number };
}

export interface KshetraStatusInfo {
  kshetra: KshetraConfig;
  daemonRunning: boolean;
  pid?: number;
  paused: boolean;
  pauseReason?: string;
  pauseMessage?: string;
  requiresManualResume?: boolean;
  activeBead?: ActiveBead;
  queueDepth: number;
  lastCompleted?: { id: string; title: string };
  phase?: string;
  lastProgressAt?: string;
  stuck?: { since: string; reason: string; remediation: string };
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

export async function assembleKshetraStatus(kshetra: KshetraConfig): Promise<KshetraStatusInfo> {
  const pid = readPid(kshetra.id);
  const daemonRunning = pid !== null && isAlive(pid);

  const state = loadState();
  const ks = state.kshetras[kshetra.id];
  const paused = ks?.paused ?? false;

  const bdClient = bd(kshetra);

  // The follow-up list is a label-filtered slice of in_progress (bd's `list --json`
  // omits labels, so the label is the only way to tell a follow-up bead apart).
  const [inProgressRaw, readyRaw, closedRaw, followupRaw] = await Promise.all([
    bdClient.list({ status: 'in_progress' }).catch(() => '[]'),
    bdClient.ready().catch(() => '[]'),
    bdClient.list({ status: 'closed' }).catch(() => '[]'),
    bdClient.list({ status: 'in_progress', label: PR_NEEDS_FOLLOWUP_LABEL }).catch(() => '[]'),
  ]);

  const followupIds = new Set(
    parseJsonArray(followupRaw)
      .map(item => BeadsItemSchema.safeParse(item))
      .filter(p => p.success)
      .map(p => (p as { data: { id: string } }).data.id),
  );

  let activeBead: ActiveBead | undefined;
  const inProgress = parseJsonArray(inProgressRaw);
  if (inProgress.length > 0) {
    const parsed = BeadsItemSchema.safeParse(inProgress[0]);
    if (parsed.success) {
      const { agent, round } = parseAgentRound(parsed.data.notes);
      // A follow-up bead in the work slot: surface its watermark round + budget so
      // the operator sees the loop is chewing on open-PR feedback, not a fresh bead.
      const followup = followupIds.has(parsed.data.id)
        ? { round: parseWatermark(parsed.data.notes).round, maxRounds: kshetra.repo.prFollowupMaxRounds }
        : undefined;
      activeBead = { id: parsed.data.id, title: parsed.data.title, agent, round, followup };
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
    pid: daemonRunning ? pid : undefined,
    paused,
    pauseReason: ks?.reason,
    pauseMessage: ks?.message,
    requiresManualResume: ks?.requiresManualResume,
    activeBead,
    queueDepth,
    lastCompleted,
    phase: ks?.phase,
    lastProgressAt: ks?.lastProgressAt,
    stuck: ks?.stuck,
  };
}
