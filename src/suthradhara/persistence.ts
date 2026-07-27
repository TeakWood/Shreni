import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { shreniDir } from '../cli/pid';
import {
  SESSION_STATE_VERSION,
  type SessionState,
} from './state';

// Layer-1 persistence (ARD §9): one JSON per session under
// ~/.shreni/suthradhara/<session-id>.json. Separate directory from the
// per-Kshetra worker state (~/.shreni/kshetra/<id>/) because a Kshetra
// accumulates many session transcripts over time and mixing them into the
// worker's runtime state directory would make cleanup harder and the layout
// harder to reason about.
//
// A session id is <kshetraId>-<yyyymmddThhmmss>-<4hex>: the prefix tells the
// operator which Kshetra it belongs to at a glance, the timestamp makes
// `readdirSync` return sessions in natural chronological order, and the hex
// suffix keeps two sessions started in the same second from colliding.

export function suthradharaSessionsDir(): string {
  return join(shreniDir(), 'suthradhara');
}

export function sessionPath(sessionId: string): string {
  return join(suthradharaSessionsDir(), `${sessionId}.json`);
}

// Bare validation on the id we accept from the CLI — filenames get joined
// straight onto suthradharaSessionsDir(), so any traversal or shell-meta
// character would be a footgun. Session ids we generate always match this.
const SESSION_ID_RE = /^[a-z0-9-]+-\d{8}T\d{6}-[0-9a-f]{4}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId);
}

export function generateSessionId(
  kshetraId: string,
  now: Date = new Date(),
  rand: () => string = () => randomBytes(2).toString('hex'),
): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mi = now.getUTCMinutes().toString().padStart(2, '0');
  const ss = now.getUTCSeconds().toString().padStart(2, '0');
  return `${kshetraId}-${yyyy}${mm}${dd}T${hh}${mi}${ss}-${rand()}`;
}

// Atomic-ish write: JSON goes to <path>.tmp first then renames into place, so
// a crash mid-write can never leave a half-written session on disk that
// resume would then choke on.
export function saveSession(state: SessionState): void {
  mkdirSync(suthradharaSessionsDir(), { recursive: true });
  const stamped: SessionState = { ...state, updatedAt: new Date().toISOString() };
  const target = sessionPath(state.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(stamped, null, 2), 'utf8');
  renameSync(tmp, target);
}

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Suthradhara session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionSchemaError extends Error {
  constructor(public readonly sessionId: string, detail: string) {
    super(`Suthradhara session "${sessionId}" is not readable: ${detail}`);
    this.name = 'SessionSchemaError';
  }
}

export function loadSession(sessionId: string): SessionState {
  if (!isValidSessionId(sessionId)) {
    throw new SessionSchemaError(sessionId, 'malformed session id');
  }
  let raw: string;
  try {
    raw = readFileSync(sessionPath(sessionId), 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new SessionNotFoundError(sessionId);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SessionSchemaError(sessionId, `invalid JSON: ${(err as Error).message}`);
  }
  return validateSessionState(sessionId, parsed);
}

// Narrow structural validation — enough to catch a foreign or corrupt file
// before xa0.2's interview loop trusts the shape. Not a full schema check;
// the runner is the only writer and we control what goes in.
function validateSessionState(sessionId: string, value: unknown): SessionState {
  if (typeof value !== 'object' || value === null) {
    throw new SessionSchemaError(sessionId, 'root is not an object');
  }
  const v = value as Partial<SessionState>;
  if (v.version !== SESSION_STATE_VERSION) {
    throw new SessionSchemaError(
      sessionId,
      `unsupported schema version: ${String(v.version)}`,
    );
  }
  if (typeof v.id !== 'string' || typeof v.kshetraId !== 'string') {
    throw new SessionSchemaError(sessionId, 'missing id or kshetraId');
  }
  if (v.id !== sessionId) {
    throw new SessionSchemaError(
      sessionId,
      `id mismatch on disk: ${v.id}`,
    );
  }
  return value as SessionState;
}

// Lightweight listing for `suthradhara list` / resume prompts. Reads only the
// filenames (cheap) and, when a kshetra filter is supplied, opens each file
// to check ownership. Sorted newest-first by the timestamp embedded in the id.
export interface SessionSummary {
  id: string;
  kshetraId: string;
  updatedAt: string;
  stage: SessionState['stage'];
}

export function listSessions(kshetraId?: string): SessionSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(suthradharaSessionsDir());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return [];
    throw err;
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!isValidSessionId(id)) continue;
    if (kshetraId && !id.startsWith(`${kshetraId}-`)) continue;
    let state: SessionState;
    try {
      state = loadSession(id);
    } catch {
      continue;
    }
    if (kshetraId && state.kshetraId !== kshetraId) continue;
    summaries.push({
      id: state.id,
      kshetraId: state.kshetraId,
      updatedAt: state.updatedAt,
      stage: state.stage,
    });
  }
  summaries.sort((a, b) => (a.id < b.id ? 1 : -1));
  return summaries;
}

// Exposed for tests and a future `suthradhara forget <id>`. Not wired to a
// CLI subcommand in xa0.3 — resume only needs read/write.
export function deleteSession(sessionId: string): void {
  if (!isValidSessionId(sessionId)) return;
  try {
    unlinkSync(sessionPath(sessionId));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
}
