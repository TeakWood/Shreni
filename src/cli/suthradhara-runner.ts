import { loadRegistry } from '../kshetra/registry';
import { writeSuthradharaPid } from '../suthradhara/pid';

// Detached entry point for a Suthradhara session (xa0.1 scaffold). Reads the
// kshetra id from argv[2], records its own PID, then idles on a heartbeat
// timer waiting for SIGTERM/SIGINT. The interactive claude-CLI turn loop is
// deferred to xa0.2 — this file exists so `shreni suthradhara start` has a
// long-lived child to detach from, its state files land in the expected
// per-Kshetra paths, and the acceptance criteria (running pid, idempotent
// start, clean stop) hold today.

const kshetraId = process.argv[2];

if (!kshetraId) {
  console.error('[suthradhara] missing kshetra id argument');
  process.exit(1);
}

const kshetra = loadRegistry().find(k => k.id === kshetraId);
if (!kshetra) {
  console.error(`[suthradhara] kshetra not registered: ${kshetraId}`);
  process.exit(1);
}

writeSuthradharaPid(kshetra.id, process.pid);
console.log(
  `[suthradhara:${kshetra.id}] session ready — cwd=${kshetra.repo.path}, model=${kshetra.agents.model}`,
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
