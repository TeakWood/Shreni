import { createInterface } from 'readline';
import { loadRegistry } from '../kshetra/registry';
import { writeSuthradharaPid } from '../suthradhara/pid';
import { loadSession, saveSession, SessionNotFoundError } from '../suthradhara/persistence';
import type { SessionState } from '../suthradhara/state';
import { runInterviewTurn, resumeInterruptedCommit, type TurnDeps } from '../suthradhara/turnloop';
import { captureClaudeTurn } from '../suthradhara/capture';
import { makeCommitFn } from '../suthradhara/commit';
import { makeLocateFn } from '../suthradhara/evolve';
import { parseGrantAnswer, renderGrantPrompt } from '../suthradhara/grant';
import { resolveConfigPath } from '../kshetra/registry';
import { persistMcpGrant } from '../kshetra/grant-persist';
import type { KshetraConfig, McpGrants } from '../kshetra/config';

// Detached entry point for a Suthradhara session. Reads the kshetra id from
// argv[2] and the session id from argv[3], records its own PID, hydrates the
// on-disk session state (xa0.3), then drives the interactive interview loop
// (xa0.11).
//
// TRANSPORT (Q11, resolved): an attached-TTY REPL. A design interview is an
// inherently foreground, synchronous back-and-forth (ARD §10, CLI-first), so the
// turn loop reads operator messages line-by-line from stdin and writes replies to
// stdout. The detached pid/log/stop/status machinery (xa0.1/xa0.3) stays for
// lifecycle bookkeeping; when the process is spawned detached with stdio
// 'ignore', stdin is not readable, readline closes immediately, and the runner
// falls back to the idle heartbeat — preserving xa0.3's resume-proof behaviour
// with no interactive input. A Vichara-style socket/PWA transport stays deferred
// (§10). Each turn folds the exchange into state and saveSession()s.

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

runReplSession(kshetra, session);

// Drive the interactive REPL over stdin/stdout. Serialises turns (a queue) so a
// second line typed while a turn is still spawning `claude` waits rather than
// racing the shared session state. On stdin close (EOF, or the detached
// stdio-'ignore' case) it keeps the process alive on a heartbeat so `resume`
// still works exactly as in xa0.3.
export function runReplSession(
  kshetra: KshetraConfig,
  initial: SessionState,
  depsOverride?: Partial<TurnDeps>,
): void {
  let state = initial;
  let busy = false;
  const queue: string[] = [];
  // In-memory session grants from interactive grant-on-demand (pmb.6). Held only
  // in this process — a new session or a resume starts empty (an `always` grant
  // reaches the next session via kshetra.yaml, not this map). Threaded through
  // every turn and updated from the turn's result.
  let sessionGrants: McpGrants = {};

  const rl = createInterface({ input: process.stdin, terminal: false });

  // While a turn is mid-flight and awaiting an operator grant decision, the next
  // stdin line is that answer — not a new interview message. `pendingLine` diverts
  // exactly one line to the grant resolver; otherwise lines flow to the turn queue.
  let pendingLine: ((line: string) => void) | null = null;
  const askOperatorLine = (promptText: string): Promise<string> =>
    new Promise((resolveLine) => {
      process.stdout.write(`\n${promptText} `);
      pendingLine = resolveLine;
    });

  // Grant-on-demand wiring: the prompt reads a line off stdin (shared readline);
  // `always` persists to kshetra.yaml via the registry-resolved config path. Both
  // are overridable so a test can drive the loop without a TTY or a real file.
  const deps: TurnDeps = {
    capture: captureClaudeTurn,
    commit: makeCommitFn(),
    save: saveSession,
    locate: makeLocateFn(kshetra),
    askGrant: async (server, tool) =>
      parseGrantAnswer(await askOperatorLine(renderGrantPrompt(server, tool))),
    persistGrant: (server, tool) => {
      const configPath = resolveConfigPath(kshetra.id);
      if (!configPath) {
        throw new Error(`kshetra "${kshetra.id}" is not registered — cannot resolve kshetra.yaml`);
      }
      persistMcpGrant(configPath, 'suthradhara', server, tool);
    },
    ...depsOverride,
  };

  const drain = async (): Promise<void> => {
    if (busy) return;
    const message = queue.shift();
    if (message === undefined) return;
    busy = true;
    try {
      const result = await runInterviewTurn(state, kshetra, message, deps, sessionGrants);
      state = result.state;
      if (result.sessionGrants) sessionGrants = result.sessionGrants;
      process.stdout.write(`\n${result.reply}\n\n`);
      for (const w of result.warnings) console.error(`[suthradhara:${kshetra.id}] ${w}`);
    } catch (err) {
      console.error(`[suthradhara:${kshetra.id}] turn failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      void drain();
    }
  };

  // Resume-time reconcile (ARD §7, Q2): if a prior confirm's commit was
  // interrupted, the session persisted its pending proposal + an in-flight commit
  // marker. Reconcile against the SAME session bead and file the remainder before
  // accepting new input — a crash mid-commit heals on the next start rather than
  // waiting for the operator to notice and re-confirm. `busy` is held for the
  // duration so an operator line typed meanwhile queues instead of racing state.
  busy = true;
  void resumeInterruptedCommit(state, kshetra, deps)
    .then((result) => {
      if (result) {
        state = result.state;
        process.stdout.write(`\n${result.reply}\n\n`);
      }
    })
    .catch((err) => {
      console.error(`[suthradhara:${kshetra.id}] resume failed: ${(err as Error).message}`);
    })
    .finally(() => {
      busy = false;
      void drain();
    });

  rl.on('line', (line) => {
    // A pending grant prompt claims the next line as its answer (§4.2), before any
    // trim/command handling — an empty line is a valid "deny" there.
    if (pendingLine) {
      const resolveLine = pendingLine;
      pendingLine = null;
      resolveLine(line);
      return;
    }
    const message = line.trim();
    if (message === '') return;
    if (message === '/exit' || message === '/quit') { shutdown(); return; }
    queue.push(message);
    void drain();
  });

  // EOF / no interactive input: don't exit — a detached session must stay
  // resumable. A no-op interval keeps the event loop alive (mirrors worker.ts).
  const HEARTBEAT_MS = 30_000;
  const heartbeat = setInterval(() => { /* keep-alive */ }, HEARTBEAT_MS);
  rl.on('close', () => { /* keep the heartbeat; process stays alive for resume */ });

  function shutdown(): void {
    clearInterval(heartbeat);
    rl.close();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
