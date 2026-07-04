import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { notificationsPath } from './activity-log.js';

// One durable alert written by notifyOperator (stuck / end-state events that need
// a human). The shape mirrors what errors.ts appends to notifications.jsonl.
export interface Notification {
  ts: string;
  event: string;
  beadId?: string;
  reason?: string;
  remediation?: string;
  message: string;
}

// Append an alert to the per-Kshetra notification feed. Never throws — a failed
// notification must not crash the worker.
export function appendNotification(kshetraId: string, entry: Notification): void {
  try {
    mkdirSync(dirname(notificationsPath(kshetraId)), { recursive: true });
    appendFileSync(notificationsPath(kshetraId), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Never let a notification failure crash the worker.
  }
}

// Read the per-Kshetra notification feed. `sinceTs`, when provided, returns only
// entries strictly newer than it — ISO-8601 timestamps sort chronologically, so
// a poller passes the last ts it delivered to avoid replaying the whole file.
// `limit`, when provided, keeps only the most recent N entries (applied after
// the sinceTs filter). A missing or corrupt feed yields []  — never throws.
export function readNotifications(
  kshetraId: string,
  opts: { sinceTs?: string; limit?: number } = {},
): Notification[] {
  let raw: string;
  try {
    raw = readFileSync(notificationsPath(kshetraId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: Notification[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Notification;
    try {
      parsed = JSON.parse(trimmed) as Notification;
    } catch {
      continue; // skip a corrupt line rather than fail the whole read
    }
    if (!parsed.ts) continue;
    if (opts.sinceTs && parsed.ts <= opts.sinceTs) continue;
    out.push(parsed);
  }

  if (opts.limit !== undefined && out.length > opts.limit) {
    return out.slice(out.length - opts.limit);
  }
  return out;
}
