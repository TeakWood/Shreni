import { z } from 'zod';
import { loadRegistry } from '../kshetra/registry';
import { bd } from '../sthapathi/beads';
import type { KshetraConfig } from '../kshetra/config';

// ── Note parsing ──────────────────────────────────────────────────────────────

export interface RoundEntry {
  round: number;
  events: string[];
}

export interface BeadLog {
  beadId: string;
  title: string;
  status: string;
  rounds: RoundEntry[];
  extra: string[]; // non-round lines (e.g. "Paused: API unavailable")
}

export function parseNotesToBeadLog(beadId: string, title: string, status: string, notes: string | undefined): BeadLog {
  const roundMap = new Map<number, string[]>();
  const extra: string[] = [];

  for (const raw of (notes ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^Round\s+(\d+):\s+(.+)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const event = m[2] ?? '';
      if (!roundMap.has(n)) roundMap.set(n, []);
      roundMap.get(n)!.push(event);
    } else {
      extra.push(line);
    }
  }

  const rounds: RoundEntry[] = Array.from(roundMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, events]) => ({ round, events }));

  return { beadId, title, status, rounds, extra };
}

export function formatBeadLog(log: BeadLog): string {
  const lines: string[] = [];
  lines.push(`[${log.status}] ${log.beadId} · ${log.title}`);

  for (const { round, events } of log.rounds) {
    lines.push(`  Round ${round}:`);
    for (const ev of events) lines.push(`    ${ev}`);
  }
  for (const ev of log.extra) lines.push(`  ${ev}`);

  return lines.join('\n');
}

// ── Beads queries ─────────────────────────────────────────────────────────────

const BeadsItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().optional(),
  notes: z.string().optional(),
});

function parseItems(raw: string): z.infer<typeof BeadsItemSchema>[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      const r = BeadsItemSchema.safeParse(item);
      return r.success ? [r.data] : [];
    });
  } catch {
    return [];
  }
}

async function getBeadLogsForKshetra(kshetra: KshetraConfig): Promise<BeadLog[]> {
  const bdClient = bd(kshetra);
  const [inProgressRaw, closedRaw] = await Promise.all([
    bdClient.list({ status: 'in_progress' }).catch(() => '[]'),
    bdClient.list({ status: 'closed' }).catch(() => '[]'),
  ]);

  const items = [
    ...parseItems(inProgressRaw),
    ...parseItems(closedRaw),
  ];

  return items.map(item =>
    parseNotesToBeadLog(item.id, item.title, item.status ?? 'unknown', item.notes),
  );
}

async function findBeadLog(beadId: string, kshetras: KshetraConfig[]): Promise<{ log: BeadLog; kshetra: KshetraConfig } | null> {
  for (const k of kshetras) {
    const bdClient = bd(k);
    try {
      const raw = await bdClient.show(beadId);
      const parsed = JSON.parse(raw);
      const item = BeadsItemSchema.safeParse(parsed);
      if (item.success) {
        return {
          log: parseNotesToBeadLog(item.data.id, item.data.title, item.data.status ?? 'unknown', item.data.notes),
          kshetra: k,
        };
      }
    } catch {
      // bead not in this kshetra
    }
  }
  return null;
}

// ── Command runner ────────────────────────────────────────────────────────────

export interface LogsOpts {
  kshetraId?: string;
  beadId?: string;
  all: boolean;
}

export async function runLogs(opts: LogsOpts): Promise<void> {
  const kshetras = loadRegistry();

  if (kshetras.length === 0) {
    console.log('No kshetras registered.');
    return;
  }

  if (opts.beadId) {
    const found = await findBeadLog(opts.beadId, kshetras);
    if (!found) {
      console.error(`Bead not found: ${opts.beadId}`);
      process.exit(1);
      return;
    }
    console.log(formatBeadLog(found.log));
    return;
  }

  const targets = opts.all
    ? kshetras
    : opts.kshetraId
      ? kshetras.filter(k => k.id === opts.kshetraId)
      : [];

  if (targets.length === 0) {
    if (opts.kshetraId) {
      console.error(`Kshetra not found: ${opts.kshetraId}`);
      process.exit(1);
    } else {
      console.error('Usage: shreni logs --kshetra <id> | --bead <id> | --all');
      process.exit(1);
    }
    return;
  }

  for (const k of targets) {
    console.log(`Kshetra: ${k.name} (${k.id})`);
    console.log('─'.repeat(50));
    const logs = await getBeadLogsForKshetra(k);
    if (logs.length === 0) {
      console.log('  No bead history.');
    } else {
      for (const log of logs) console.log(formatBeadLog(log));
    }
    console.log();
  }
}