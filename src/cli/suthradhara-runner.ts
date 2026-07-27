import { loadRegistry } from '../kshetra/registry';
import { writeSuthradharaPid } from '../suthradhara/pid';
import { loadSession, SessionNotFoundError } from '../suthradhara/persistence';
import type { SessionState } from '../suthradhara/state';

// Detached entry point for a Suthradhara session. Reads the kshetra id from
// argv[2] and the session id from argv[3], records its own PID, hydrates the
// on-disk session state (xa0.3), then idles waiting for SIGTERM/SIGINT.
//
// The actual interview turn loop (stage machine, rubric checks, transcript
// updates) lands in xa0.2 — this file's job today is to prove the state made
// it across the fork so `resume` continues the same conversation instead of
// starting over. xa0.2 will consume `session` from here and call saveSession
// after each turn.

const kshetraId = process.argv[2];
const sessionId = process.argv[3];

if (!kshetraId) {
  console.error('[suthradhara] missing kshetra id argument');
  process.exit(1);
}
if (!sessionId) {
  console.error('[suthradhara] missing session id argument');
  process.exit(1);
}

const kshetra = loadRegistry().find(k => k.id === kshetraId);
if (!kshetra) {
  console.error(`[suthradhara] kshetra not registered: ${kshetraId}`);
  process.exit(1);
}

let session: SessionState;
try {
  session = loadSession(sessionId);
} catch (err) {
  if (err instanceof SessionNotFoundError) {
    console.error(
      `[suthradhara:${kshetraId}] session ${sessionId} not found — parent should have created it`,
    );
  } else {
    console.error(`[suthradhara:${kshetraId}] failed to load session ${sessionId}: ${(err as Error).message}`);
  }
  process.exit(1);
}
if (session.kshetraId !== kshetra.id) {
  console.error(
    `[suthradhara:${kshetraId}] session ${sessionId} belongs to ${session.kshetraId}, refusing to run`,
  );
  process.exit(1);
}

writeSuthradharaPid(kshetra.id, process.pid);
console.log(
  `[suthradhara:${kshetra.id}] session ${session.id} ready — ` +
    `cwd=${kshetra.repo.path}, model=${kshetra.agents.model}, ` +
    `stage=${session.stage}, transcript-turns=${session.transcript.length}`,
);

// Keep the event loop alive until a signal arrives. A no-op setInterval is
// cheaper than a leaked promise and mirrors worker.ts's own liveness pattern.
const HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => { /* keep-alive */ }, HEARTBEAT_MS);

function shutdown(): void {
  clearInterval(heartbeat);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
