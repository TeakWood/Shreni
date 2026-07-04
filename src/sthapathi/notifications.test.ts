import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = join(tmpdir(), `shreni-notifications-test-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => dir };
});

const { appendNotification, readNotifications } = await import('./notifications.js');
const { notificationsPath } = await import('./activity-log.js');

const KID = 'myapp';

function writeFeed(lines: string[]): void {
  mkdirSync(join(dir, '.shreni', 'kshetra', KID), { recursive: true });
  writeFileSync(notificationsPath(KID), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

beforeEach(() => {
  mkdirSync(join(dir, '.shreni'), { recursive: true });
});

afterEach(() => {
  try { rmSync(join(dir, '.shreni'), { recursive: true }); } catch { /* ok */ }
});

describe('readNotifications', () => {
  it('returns [] for a missing feed (never throws)', () => {
    expect(readNotifications('nonexistent')).toEqual([]);
  });

  it('reads all entries in append order', () => {
    writeFeed([
      JSON.stringify({ ts: '2026-06-30T09:00:00Z', event: 'stuck', message: 'a' }),
      JSON.stringify({ ts: '2026-06-30T09:01:00Z', event: 'git_failed', message: 'b' }),
    ]);
    const out = readNotifications(KID);
    expect(out.map(n => n.event)).toEqual(['stuck', 'git_failed']);
  });

  it('skips corrupt and blank lines instead of throwing', () => {
    writeFeed([
      JSON.stringify({ ts: '2026-06-30T09:00:00Z', event: 'stuck', message: 'a' }),
      'not json {{{',
      '',
      JSON.stringify({ event: 'no-ts', message: 'dropped' }), // missing ts → skipped
      JSON.stringify({ ts: '2026-06-30T09:02:00Z', event: 'merge_conflict', message: 'c' }),
    ]);
    const out = readNotifications(KID);
    expect(out.map(n => n.event)).toEqual(['stuck', 'merge_conflict']);
  });

  it('sinceTs returns only strictly-newer entries', () => {
    writeFeed([
      JSON.stringify({ ts: '2026-06-30T09:00:00Z', event: 'a', message: 'a' }),
      JSON.stringify({ ts: '2026-06-30T09:01:00Z', event: 'b', message: 'b' }),
      JSON.stringify({ ts: '2026-06-30T09:02:00Z', event: 'c', message: 'c' }),
    ]);
    const out = readNotifications(KID, { sinceTs: '2026-06-30T09:01:00Z' });
    expect(out.map(n => n.event)).toEqual(['c']);
  });

  it('limit keeps only the most recent N (after the sinceTs filter)', () => {
    writeFeed([
      JSON.stringify({ ts: '2026-06-30T09:00:00Z', event: 'a', message: 'a' }),
      JSON.stringify({ ts: '2026-06-30T09:01:00Z', event: 'b', message: 'b' }),
      JSON.stringify({ ts: '2026-06-30T09:02:00Z', event: 'c', message: 'c' }),
    ]);
    expect(readNotifications(KID, { limit: 2 }).map(n => n.event)).toEqual(['b', 'c']);
    expect(readNotifications(KID, { limit: 0 })).toEqual([]);
  });
});

describe('appendNotification', () => {
  it('round-trips through readNotifications', () => {
    appendNotification(KID, { ts: '2026-06-30T10:00:00Z', event: 'stuck', message: 'hung', reason: 'r' });
    const out = readNotifications(KID);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: 'stuck', message: 'hung', reason: 'r' });
  });

  it('creates the feed directory if missing and never throws', () => {
    expect(() =>
      appendNotification('brand-new-kshetra', { ts: '2026-06-30T10:00:00Z', event: 'x', message: 'm' }),
    ).not.toThrow();
    expect(readNotifications('brand-new-kshetra')).toHaveLength(1);
  });
});
