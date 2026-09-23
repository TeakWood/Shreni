import { createInterface } from 'readline';
import { loadRegistry } from '../kshetra/registry';
import { resolveKshetra } from './status';
import {
  startSession,
  stopSession,
  statusSession,
  resumeSession,
  teardownWorktrees,
  type LaunchResult,
  type StartOpts,
} from '../suthradhara/lifecycle';
import { listSessions } from '../suthradhara/persistence';
import { readHandoff, type Handoff } from '../suthradhara/handoff';
import { emit as emitActivity, type ActivityEvent } from '../sthapathi/activity-log';
import { timed } from '../sthapathi/timing';
import { getUsageMeter, getPolicySource, costFor, type UsageMeter, type PolicySource, type PolicyDecision } from '../ext/index';
import { readSessionUsage, type SessionUsage } from '../suthradhara/usage';
import { resolveAgentModel, type KshetraConfig } from '../kshetra/config';
import { checkBaseBranch, createBaseBranch } from '../sthapathi/base-branch';

// Resolve the target Kshetra for a Suthradhara subcommand. Precedence:
//   1. @<id> as a bare positional token (at-mention)
//   2. --kshetra <id> flag
//   3. cwd falls inside a registered Kshetra's repo path
// Any explicit id (1 or 2) must resolve; a cwd fallback that misses returns an
// error mentioning both alternatives so the operator knows their options.

const AT_MENTION = /^@([a-z0-9-]+)$/;

export function parseAtMention(args: string[]): string | undefined {
  for (const arg of args) {
    const match = AT_MENTION.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}

export function resolveTargetKshetra(
  args: string[],
  flagValue: string | undefined,
  cwd: string,
  kshetras: KshetraConfig[],
): KshetraConfig {
  if (kshetras.length === 0) {
    throw new Error('No kshetras registered. Run `shreni register` first.');
  }

  const atId = parseAtMention(args);
  const explicitId = atId ?? flagValue;

  if (explicitId) {
    const found = kshetras.find(k => k.id === explicitId);
    if (!found) throw new Error(`Kshetra not found: ${explicitId}`);
    return found;
  }

  const cwdMatch = resolveKshetra(kshetras, cwd);
  if (cwdMatch) return cwdMatch;

  throw new Error(
    `No kshetra resolvable from cwd: ${cwd}\n` +
      'Hint: pass @<id> or --kshetra <id> to select one.',
  );
}

export type SuthradharaSubcommand = 'start' | 'stop' | 'status' | 'resume' | 'list';

export function isSubcommand(x: string | undefined): x is SuthradharaSubcommand {
  return x === 'start' || x === 'stop' || x === 'status' || x === 'resume' || x === 'list';
}

// A session id lands as a bare positional (no leading @), sitting alongside an
// optional @<kshetra> mention on `resume`. Distinguish by the id shape — the
// generator's format matches this pattern exactly.
const SESSION_ID_ARG_RE = /^[a-z0-9-]+-\d{8}T\d{6}-[0-9a-f]{4}$/;

export function parseSessionId(args: string[]): string | undefined {
  for (const arg of args) {
    if (SESSION_ID_ARG_RE.test(arg)) return arg;
  }
  return undefined;
}

// The kshetra id is embedded in the session id — infer it so `resume <id>`
// works without a redundant @<kshetra> mention.
export function kshetraIdFromSessionId(sessionId: string): string {
  return sessionId.replace(/-\d{8}T\d{6}-[0-9a-f]{4}$/, '');
}

export interface RunOpts {
  args: string[];
  flagKshetra: string | undefined;
  cwd: string;
  kshetras?: KshetraConfig[];
}

export async function runSuthradhara(sub: string | undefined, opts: RunOpts): Promise<void> {
  if (!isSubcommand(sub)) {
    throw new Error(
      'Usage: shreni suthradhara <start|resume <session-id>|stop|status|list> [@<id> | --kshetra <id>]',
    );
  }
  const kshetras = opts.kshetras ?? loadRegistry();

  if (sub === 'resume') {
    await runResume(opts, kshetras);
    return;
  }

  if (sub === 'list') {
    runList(opts, kshetras);
    return;
  }

  const kshetra = resolveTargetKshetra(opts.args, opts.flagKshetra, opts.cwd, kshetras);

  if (sub === 'start') {
    if (!gateFirstLaunch(kshetra, 'launching')) return; // fnd.7: budget gate
    // uvu.6: verify the base branch exists before startSession cuts a worktree
    // from origin/<mainBranch>. Skip when a session is already running — no
    // launch, no cut (mirrors gateFirstLaunch's already-running short-circuit).
    if (!statusSession(kshetra.id).running && !(await ensureBaseBranchForLaunch(kshetra))) return;
    const result = await startSession(kshetra);
    if (result.status === 'already_running') {
      console.log(`suthradhara[${result.kshetraId}]: already running (pid ${result.pid})`);
    } else {
      await runPlanningLoop(kshetra, result);
    }
  } else if (sub === 'stop') {
    const result = await stopSession(kshetra);
    if (result.status === 'stopped') {
      console.log(`suthradhara[${result.kshetraId}]: stopped (pid ${result.pid})`);
    } else if (result.status === 'stale_pid_cleared') {
      console.log(`suthradhara[${result.kshetraId}]: was not running (stale PID file cleared)`);
    } else {
      console.log(`suthradhara[${result.kshetraId}]: not running`);
    }
  } else {
    const result = statusSession(kshetra.id);
    if (result.running) {
      console.log(`suthradhara[${result.kshetraId}]: running (pid ${result.pid})`);
      console.log(`Log: ${result.logPath}`);
    } else {
      console.log(`suthradhara[${result.kshetraId}]: not running`);
    }
  }
}

async function runResume(opts: RunOpts, kshetras: KshetraConfig[]): Promise<void> {
  const sessionId = parseSessionId(opts.args);
  if (!sessionId) {
    throw new Error(
      'Usage: shreni suthradhara resume <session-id>\n' +
        'Hint: run `shreni suthradhara list` to see available sessions.',
    );
  }
  const kshetraId = kshetraIdFromSessionId(sessionId);
  const kshetra = kshetras.find(k => k.id === kshetraId);
  if (!kshetra) {
    throw new Error(
      `Session "${sessionId}" refers to kshetra "${kshetraId}", which is not registered.`,
    );
  }

  // fnd.7: a resume relaunches an interactive session, so gate it on the budget
  // cap too (via the same first-launch gate the `start` command uses).
  if (!gateFirstLaunch(kshetra, 'resuming')) return;
  // uvu.6: base-branch preflight before resumeSession touches a worktree cut
  // from origin/<mainBranch>. Skip when already running (no relaunch, no cut).
  if (!statusSession(kshetra.id).running && !(await ensureBaseBranchForLaunch(kshetra))) return;

  const result = await resumeSession(kshetra, sessionId);
  if (result.status === 'already_running') {
    console.log(
      `suthradhara[${result.kshetraId}]: already running (pid ${result.pid}); resume is a no-op`,
    );
  } else {
    await runPlanningLoop(kshetra, result, {}, /* firstResume */ true);
  }
}

// The launcher-owned control loop (epic d3y). Each iteration is ONE short-lived,
// single-purpose Claude Code planning session: we block on it, then — on exit —
// read its handoff, print the summary + merge prompt, and offer extend / new /
// end. The operator is never left in a free-roaming session: completion always
// returns here, to the bounded menu.
//
// "extend" relaunches a FRESH claude session in the SAME worktree seeded with
// the just-written doc; "new story" reaps the worktree and starts fresh; "end"
// tears the worktree down and returns. SIGINT is swallowed while a child runs so
// Ctrl-C reaches the interactive session, not this parent.
export interface PlanningLoopDeps {
  // Read one line from the operator (the menu answer). Injected so tests drive
  // the loop without a TTY.
  ask?: (prompt: string) => Promise<string>;
  // Passed through to startSession — the spawn/uuid seams a test uses to avoid
  // launching real claude.
  startOpts?: Pick<StartOpts, 'spawn' | 'uuid'>;
  log?: (msg: string) => void;
  // Lifecycle-event sink (fnd.2). Defaults to the real activity-log emit; tests
  // inject a spy to assert the emitted sequence without touching disk.
  emit?: (ev: ActivityEvent) => void;
  // Token-usage recording seams (fnd.4). `meter` defaults to the shared
  // getUsageMeter(); `readUsage` recovers a session's usage from its transcript.
  // Injected so tests assert one record per session without a real transcript.
  meter?: UsageMeter;
  readUsage?: (cwd: string, claudeSessionId: string) => SessionUsage;
  // Budget gate seam (fnd.7). Defaults to the shared getPolicySource(); injected
  // so tests can drive the deny path without wiring a real budget policy.
  policy?: PolicySource;
  // Base-branch preflight seam (uvu.6). Defaults to ensureBaseBranchForLaunch
  // wired to this loop's ask/log; injected so tests drive the missing-base path.
  ensureBaseBranch?: (kshetra: KshetraConfig) => Promise<boolean>;
}

export type MenuChoice = 'extend' | 'new' | 'end';

// Map a raw menu answer to a choice, or null if unrecognised (the loop re-asks).
export function parseMenuChoice(raw: string): MenuChoice | null {
  const s = raw.trim().toLowerCase();
  if (s === '1' || s === 'extend' || s === 'e') return 'extend';
  if (s === '2' || s === 'new' || s === 'new story' || s === 'n') return 'new';
  if (s === '3' || s === 'end' || s === 'quit' || s === 'q') return 'end';
  return null;
}

// Render the post-session summary + merge instructions. Degrades gracefully when
// the handoff is missing (a session that exited before completing the push).
export function renderSummary(kshetra: KshetraConfig, handoff: Handoff | null): string[] {
  const lines: string[] = ['', '─ planning unit complete ─'];
  if (handoff) {
    lines.push(
      `  epic:   ${handoff.epicId}`,
      `  doc:    ${handoff.docPath}`,
      `  branch: ${handoff.branch}`,
      `  ${handoff.summary}`,
      '',
      'Merge this branch when you are ready (it was pushed, not merged):',
      `  gh pr create --base ${kshetra.repo.mainBranch} --head ${handoff.branch}   # or your merge flow`,
    );
  } else {
    lines.push(
      '  (no handoff record found — the session may have exited before completing the push.)',
      '  Check `bd list` and the worktree branch to see what landed.',
    );
  }
  return lines;
}

// Pre-launch budget gate (epic fnd.7). A planning session's spend lands against
// the Kshetra (its per-bead spend is $0 until it files an epic, whose spend is
// keyed separately), so this enforces the per-Kshetra USD cap — mirroring
// runner.ts's pre-run mayProceed, but at the LAUNCH boundary because an
// interactive session can't be killed mid-stream once spawned. Consults the
// active policy and records a policy_decision event (like runner.ts) so a blocked
// launch shows on the ledger, not just as an absence. Fail-open: the default
// static policy — and a Kshetra with no budget caps — always allows.
export function mayLaunchSession(
  kshetra: KshetraConfig,
  emit: (ev: ActivityEvent) => void,
  policy: PolicySource,
): PolicyDecision {
  const { provider, model } = resolveAgentModel(kshetra, 'suthradhara');
  // Synthetic per-Kshetra bead key: a fresh session owns no bead at launch, so
  // per-bead spend reads $0 and the per-bead cap never fires here — the
  // per-Kshetra cap is what gates a launch.
  const beadId = `suthradhara:${kshetra.id}`;
  const decision = policy.mayProceed({ kshetra: kshetra.id, beadId, agent: 'suthradhara', provider, model });
  emit({
    type: 'policy_decision',
    kshetra: kshetra.id, beadId, agent: 'suthradhara', policy: 'mayProceed',
    provider, model,
    allowed: decision.allowed,
    ...(decision.allowed ? {} : { reason: decision.reason }),
  });
  return decision;
}

// Gate the FIRST launch of a command (start / resume) on the budget cap, but only
// when a launch would actually happen — an already-running session is a no-op, so
// skip the gate (and its policy_decision event) rather than record a decision for
// a launch that won't occur. Returns true to proceed, or false (after logging the
// denial) to abort. `verb` distinguishes the operator-facing message per command.
function gateFirstLaunch(kshetra: KshetraConfig, verb: 'launching' | 'resuming'): boolean {
  if (statusSession(kshetra.id).running) return true; // no launch → nothing to gate
  const gate = mayLaunchSession(kshetra, emitActivity, getPolicySource());
  if (gate.allowed) return true;
  const noun = verb === 'launching' ? 'launching a planning session' : 'resuming the planning session';
  console.log(`suthradhara[${kshetra.id}]: ${gate.reason} — not ${noun}.`);
  return false;
}

// Injectable seams for the base-branch preflight, so tests drive it without a
// real origin or TTY.
export interface BaseBranchPreflightDeps {
  ask?: (q: string) => Promise<string>;
  check?: (k: KshetraConfig) => Promise<{ exists: boolean }>;
  create?: (k: KshetraConfig) => Promise<{ branch: string; base: string }>;
  log?: (m: string) => void;
}

// Interactive base-branch preflight before a planning-session launch (uvu.6).
// Suthradhara worktrees are cut from origin/<mainBranch> (worktree.ts), so a
// missing base branch fails deep in worktree creation. Check up front via the
// shared helper (uvu.2): if it exists, proceed; if missing, prompt to create+
// push it (cut from origin's default) — on yes proceed, on no abort the launch
// with a clear message. Returns whether the launch may proceed. A failed origin
// check aborts rather than diving into a doomed worktree cut.
export async function ensureBaseBranchForLaunch(
  kshetra: KshetraConfig,
  deps: BaseBranchPreflightDeps = {},
): Promise<boolean> {
  const ask = deps.ask ?? defaultAsk;
  const check = deps.check ?? checkBaseBranch;
  const create = deps.create ?? createBaseBranch;
  const log = deps.log ?? ((m: string) => console.log(m));
  const branch = kshetra.repo.mainBranch;

  let exists: boolean;
  try {
    ({ exists } = await check(kshetra));
  } catch (err) {
    log(
      `suthradhara[${kshetra.id}]: could not check origin for base branch "${branch}" — ` +
        `${(err as Error).message}. Aborting launch.`,
    );
    return false;
  }
  if (exists) return true;

  const answer = (
    await ask(`Base branch "${branch}" does not exist on origin. Create and push it now? [y/N] `)
  ).trim();
  if (!/^y(es)?$/i.test(answer)) {
    log(
      `suthradhara[${kshetra.id}]: base branch "${branch}" is missing on origin — launch aborted. ` +
        `Create it (e.g. \`shreni base-branch create ${kshetra.id}\`) and retry.`,
    );
    return false;
  }
  try {
    const { base } = await create(kshetra);
    log(`suthradhara[${kshetra.id}]: created origin/${branch} from origin/${base}.`);
    return true;
  } catch (err) {
    log(
      `suthradhara[${kshetra.id}]: failed to create origin/${branch} — ` +
        `${(err as Error).message}. Launch aborted.`,
    );
    return false;
  }
}

async function runPlanningLoop(
  kshetra: KshetraConfig,
  first: LaunchResult,
  deps: PlanningLoopDeps = {},
  firstResume = false,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const ask = deps.ask ?? defaultAsk;
  const emit = deps.emit ?? emitActivity;
  const meter = deps.meter ?? getUsageMeter();
  const readUsage = deps.readUsage ?? readSessionUsage;
  const policy = deps.policy ?? getPolicySource();
  const ensureBaseBranch =
    deps.ensureBaseBranch ?? ((k: KshetraConfig) => ensureBaseBranchForLaunch(k, { ask, log }));
  const { provider, model } = resolveAgentModel(kshetra, 'suthradhara');
  let current = first;
  // The first session may be a resume (`suthradhara resume`); every relaunch the
  // loop drives (extend/new) is a fresh session, so this flips false after one.
  let launchWasResume = firstResume;

  for (;;) {
    emit({
      type: 'suthradhara_launched',
      kshetra: kshetra.id,
      sessionId: current.sessionId,
      claudeSessionId: current.claudeSessionId,
      resume: launchWasResume,
    });
    log(`suthradhara[${kshetra.id}]: planning session live (${current.sessionId}).`);
    log('Interview, approve the plan, and end the session (Ctrl-D / /exit) to return here.');

    const swallow = (): void => {};
    process.on('SIGINT', swallow);
    // Time the planning session at the site (Shreni-beads-27a): from the moment
    // this loop takes over the live child (startSession/resumeSession spawned it
    // just before) to its exit, on the same monotonic clock the executors use.
    // Carried on its usage record and run_usage fold below. A wait() that throws
    // meters nothing, so the success-path timed() is enough.
    let sessionDurationMs: number;
    try {
      ({ durationMs: sessionDurationMs } = await timed(() => current.wait()));
    } finally {
      process.off('SIGINT', swallow);
    }

    const handoff = readHandoff(current.worktreePath);
    // Gate ① (plan filed) + Gate ② (doc pushed) only fire when the session
    // completed the handoff; a session that exited early emits neither.
    if (handoff) {
      emit({
        type: 'suthradhara_plan_filed',
        kshetra: kshetra.id, sessionId: current.sessionId,
        epicId: handoff.epicId, docPath: handoff.docPath, summary: handoff.summary,
      });
      emit({
        type: 'suthradhara_doc_pushed',
        kshetra: kshetra.id, sessionId: current.sessionId,
        branch: handoff.branch, docPath: handoff.docPath,
      });
    }
    // The planning unit has ended (the child exited) regardless of what filed.
    emit({
      type: 'suthradhara_session_ended',
      kshetra: kshetra.id, sessionId: current.sessionId,
      ...(handoff ? { epicId: handoff.epicId } : {}),
    });

    // Recover token usage from the session transcript and meter it — exactly one
    // record per session (fresh, extend, new-story alike), through the SAME seam
    // the executors use. We record even when recovery returns zeros (missing/soft
    // transcript): the session still happened, so it gets one accounted entry
    // rather than silently vanishing from spend. beadId is the filed epic id, or
    // the sessionId when nothing was filed; runId is the pinned claude session id.
    // Guarded so a metering hiccup never crashes the planning loop.
    const usageBeadId = handoff?.epicId ?? current.sessionId;
    try {
      const usage = readUsage(current.worktreePath, current.claudeSessionId);
      const record = {
        kshetra: kshetra.id,
        beadId: usageBeadId,
        runId: current.claudeSessionId,
        agent: 'suthradhara' as const,
        provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        toolCallCount: usage.toolCallCount,
        outcome: 'ok' as const,
        durationMs: sessionDurationMs,
      };
      meter.record(record);
      // Fold the same record into the run_usage stream (epic fnd.6), like
      // runner.ts: the headline totals + cost, NOT the cache/tool breakdown (that
      // stays in usage.jsonl, referenced by runId). costFor is the same pure price
      // lookup the meter uses, so this cost matches the usage.jsonl entry exactly.
      // One run_usage per planning session, 1:1 with the meter record above.
      //
      // NESTED, not sibling, try (unlike runner.ts's two independent blocks): the
      // fold sits INSIDE the metering try, AFTER meter.record. So a meter.record
      // throw skips this emit (falls to the outer catch) — deliberate, because the
      // event documents itself as a summary of the UsageEntry the meter wrote, and
      // emitting it when the write failed would claim usage that isn't in
      // usage.jsonl. The inner try only isolates a fold failure from the metering
      // that already succeeded; neither ever crashes the planning loop.
      try {
        const { costUsd, priced } = costFor(record);
        emit({
          type: 'run_usage',
          kshetra: kshetra.id,
          beadId: usageBeadId,
          agent: 'suthradhara',
          provider,
          model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          costUsd,
          priced,
          outcome: 'ok',
          // Read off the record so the two shapes carry the same value (dt7).
          durationMs: record.durationMs,
        });
      } catch (err) {
        log(`suthradhara[${kshetra.id}]: run_usage fold failed — ${(err as Error).message}`);
      }
    } catch (err) {
      log(`suthradhara[${kshetra.id}]: usage metering failed — ${(err as Error).message}`);
    }

    for (const line of renderSummary(kshetra, handoff)) log(line);

    let choice: MenuChoice | null = null;
    while (choice === null) {
      const answer = await ask('\nWhat next?  [1] extend this topic   [2] new story   [3] end\n> ');
      choice = parseMenuChoice(answer);
      if (choice === null) log('Please answer 1, 2, or 3.');
    }
    emit({ type: 'suthradhara_menu_choice', kshetra: kshetra.id, sessionId: current.sessionId, choice });

    if (choice === 'end') {
      await teardownWorktrees(kshetra);
      log(`suthradhara[${kshetra.id}]: planning ended.`);
      return;
    }

    // fnd.7: gate the extend/new relaunch on the budget cap before spending more.
    // A denied continuation ends the loop cleanly (teardown + return) rather than
    // opening another session the Kshetra can't afford.
    const gate = mayLaunchSession(kshetra, emit, policy);
    if (!gate.allowed) {
      log(`suthradhara[${kshetra.id}]: ${gate.reason} — ending planning instead of launching another session.`);
      await teardownWorktrees(kshetra);
      return;
    }

    // uvu.6: a "new" relaunch reaps the worktree and cuts a fresh one from
    // origin/<mainBranch>; verify the base branch still exists before doing so,
    // rather than failing deep in worktree creation. ("extend" reuses the
    // current worktree — no fresh cut — so the check is cheap and passes.)
    if (!(await ensureBaseBranch(kshetra))) {
      await teardownWorktrees(kshetra);
      return;
    }

    const startOpts: StartOpts =
      choice === 'extend'
        ? { ...deps.startOpts, reuseWorktree: current.worktreePath, extendDocRelPath: handoff?.docPath }
        : { ...deps.startOpts };
    if (choice === 'new') await teardownWorktrees(kshetra);

    const next = await startSession(kshetra, startOpts);
    if (next.status === 'already_running') {
      log(`suthradhara[${kshetra.id}]: another session is already running (pid ${next.pid}); stopping the loop.`);
      return;
    }
    current = next;
    launchWasResume = false; // loop-driven relaunches are always fresh sessions
  }
}

// Read one line from stdin for the menu. Isolated so tests inject their own.
function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function runList(opts: RunOpts, kshetras: KshetraConfig[]): void {
  // A kshetra filter is optional — with no @<id> or --kshetra, we list every
  // session on disk so the operator can pick from across projects.
  const atId = parseAtMention(opts.args) ?? opts.flagKshetra;
  const sessions = listSessions(atId);
  if (sessions.length === 0) {
    console.log(atId ? `No suthradhara sessions for ${atId}.` : 'No suthradhara sessions.');
    return;
  }
  for (const s of sessions) {
    console.log(`${s.id}  kshetra=${s.kshetraId}  status=${s.status}  updated=${s.updatedAt}`);
  }
}

// Exported for tests: drive the loop directly with injected deps.
export { runPlanningLoop };
