import { z } from 'zod';
import { loadRegistry } from '../kshetra/registry';
import { withTrackerReads } from '../policy/sthapathi/reads';
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
  const [inProgressRaw, closedRaw] = await withTrackerReads(kshetra, r => Promise.all([
    r.list({ status: 'in_progress' }).catch(() => '[]'),
    r.list({ status: 'closed' }).catch(() => '[]'),
  ])).catch(() => ['[]', '[]']);

  const items = [
    ...parseItems(inProgressRaw),
    ...parseItems(closedRaw),
  ];

  return items.map(item =>
    parseNotesToBeadLog(item.id, item.title, item.status ?? 'unknown', item.notes),
  );
}

// `bd show <id> --json` returns an ARRAY: the requested bead first, then any
// dependencies. bd also resolves a short id (`8ym` → `Shreni-beads-8ym`) and
// echoes the canonical one, so match the exact id, else take the head row.
// Parsing the payload as a single object never matched (Shreni-beads-8ym).
function parseShowItem(raw: string, beadId: string): z.infer<typeof BeadsItemSchema> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const row = parsed.find(r => (r as { id?: unknown } | null)?.id === beadId) ?? parsed[0];
  const item = BeadsItemSchema.safeParse(row);
  return item.success ? item.data : null;
}

async function findBeadLog(beadId: string, kshetras: KshetraConfig[]): Promise<{ log: BeadLog; kshetra: KshetraConfig } | null> {
  for (const k of kshetras) {
    try {
      const item = parseShowItem(await withTrackerReads(k, r => r.show(beadId)), beadId);
      if (item) {
        return {
          log: parseNotesToBeadLog(item.id, item.title, item.status ?? 'unknown', item.notes),
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
    // `--kshetra` scopes the lookup. Without it every kshetra is tried in registry
    // order and the first that resolves the id wins — a short id can exist in
    // more than one, so the header names where the bead was found.
    const scope = opts.kshetraId ? kshetras.filter(k => k.id === opts.kshetraId) : kshetras;
    if (scope.length === 0) {
      console.error(`Kshetra not found: ${opts.kshetraId}`);
      process.exit(1);
      return;
    }
    const found = await findBeadLog(opts.beadId, scope);
    if (!found) {
      console.error(`Bead not found: ${opts.beadId}`);
      process.exit(1);
      return;
    }
    console.log(`Kshetra: ${found.kshetra.name} (${found.kshetra.id})`);
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