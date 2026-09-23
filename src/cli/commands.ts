// The single source of truth for `shreni`'s commands. Each entry is a thin
// `Command` descriptor: its usage hint sits right next to the flags it reads,
// and its `run` calls the behavior which lives (unchanged) in the sibling
// handler modules. Adding a command means adding one entry here — no switch,
// no hand-synced usage block, no duplicated error/exit boilerplate (the
// dispatcher in ./registry owns unknown-command handling and catch -> exit 1).

import type { Command } from './registry';
import { renderHelp } from './registry';
import { startWorker } from './start';
import { stopWorker } from './stop';
import { runStatus } from './status';
import { loadRegistry } from '../kshetra/registry';
import { pauseKshetraById, resumeKshetraById } from './pause';
import { createBaseBranchForKshetra } from './base-branch';
import { runAgents } from './agents';
import { runLogs } from './logs';
import { runDrain, formatDrainResult, drainResultJson, type DrainOptions } from './drain';
import type { CommandContext } from './registry';
import { runFreeze } from './freeze';
import { runExport } from './export';
import { runRestore } from './restore';
import { runSnapshots } from './snapshots';
import { runSync } from './sync';
import { initKshetra } from './init-kshetra';
import { runRegister } from './register';
import { runMigrate } from './migrate';
import { verifyHooks } from './verify-hooks';
import { runList } from './list';
import { startPhalaka, stopPhalaka, statusPhalaka } from './phalaka';
import { autoStartPhalaka, autoStopPhalaka } from './phalaka-autostart';
import { runSuthradhara } from './suthradhara';
import { runTail } from './tail';
import { runReport } from './report';
import { runShow } from './show';
import { runInit } from './init';
import { runTelemetry } from './telemetry';
import { parseLabels } from './labels';
import { ablationGuardError } from '../kshetra/ablation';
import { emit as emitTelemetry } from '../telemetry/telemetry';

const DRAIN_USAGE = '--kshetra <id> [--epic <id>] [--max-cycles <n>] [--label key=value ...] [--allow-ablation] [--json]';
const RUN_USAGE = '--kshetra <id> [--label key=value ...] [--allow-ablation] [--json]';
const DRAIN_EXIT_CODES =
  'Exit codes: 0 complete · 10 stalled · 11 budget · 12 capped by --max-cycles with beads still open · 130/143 signal';
const RUN_HELP = [
  'shreni run is `shreni drain --max-cycles 1`: it starts the real worker runtime',
  '(recovery, ledger, persisted phase, heartbeat, timers), works at most one cycle,',
  'then runs drain\'s exit sequence (final sync, stall classification, drain_finished).',
  'Startup recovery may first resume WIP beads a crash left in progress, as the worker',
  'does. Do not run it beside a `shreni start` daemon on the same kshetra. SIGINT/SIGTERM',
  'stop it at the next check-point, after the in-flight task. Use `shreni drain`',
  'directly for --epic scoping or a larger --max-cycles.',
  DRAIN_EXIT_CODES,
].join('\n');

function wantsHelp(ctx: CommandContext): boolean {
  return ctx.has('--help') || ctx.has('-h');
}

// `--max-cycles <n>`: a positive integer, or undefined when absent. Malformed
// input fails fast here rather than silently running uncapped.
export function parseMaxCycles(ctx: CommandContext): number | undefined {
  if (!ctx.has('--max-cycles')) return undefined;
  const raw = ctx.flag('--max-cycles');
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`Invalid --max-cycles "${raw ?? ''}": expected a positive integer.`);
  }
  return n;
}

// The shared body of `drain` and its `run` alias: run the drain, print the
// summary, and exit with its code. drain owns its exit code (0 complete / 10
// stalled / 11 budget / 12 capped / 130·143 signal) — the whole point is a
// machine-readable end — so it exits directly rather than returning to the
// dispatcher (which only distinguishes 0 from 1).
async function drainAndExit(ctx: CommandContext, id: string, opts: DrainOptions): Promise<void> {
  // Opaque run labels (epic yrk / Study B2); malformed --label fails fast here.
  const labels = parseLabels(ctx.args);
  const result = await runDrain(id, { ...opts, labels, allowAblation: ctx.has('--allow-ablation') });
  console.log(ctx.has('--json') ? drainResultJson(result) : formatDrainResult(result));
  process.exit(result.exitCode);
}

export const COMMANDS: Command[] = [
  {
    name: 'start',
    summary: 'Start worker daemons (and the phalaka dashboard) for registered kshetras',
    usage: '[--kshetra <id>] [--label key=value ...] [--allow-ablation]',
    run(ctx) {
      const id = ctx.flag('--kshetra');
      // Parse opaque run labels (epic yrk / Study B2) up front so a malformed or
      // duplicate --label fails fast, before any worker is spawned.
      const labels = parseLabels(ctx.args);
      // Ablation guard (epic 8wi / Study B1): a Kshetra with active ablations must
      // not start without --allow-ablation, so a copied config can't silently weaken.
      const allowAblation = ctx.has('--allow-ablation');
      const registry = loadRegistry();
      const targets = id ? registry.filter(k => k.id === id) : registry;
      if (registry.length === 0) {
        throw new Error('No kshetras registered. Run `shreni register` first.');
      }
      if (id && targets.length === 0) {
        throw new Error(`Kshetra not found: ${id}`);
      }
      for (const k of targets) {
        const ablationErr = ablationGuardError(k, allowAblation);
        if (ablationErr) throw new Error(`${k.id}: ${ablationErr}`);
      }
      for (const k of targets) {
        const result = startWorker(k.id, labels, allowAblation);
        if (result.status === 'already_running') {
          console.log(`${k.id}: already running (pid ${result.pid})`);
        } else {
          console.log(`${k.id}: started (pid ${result.pid})`);
        }
      }
      // Retention signal (yds.5) — opt-in + anonymous, a no-op unless enabled.
      emitTelemetry('session_start', { kshetras: targets.length });
      const dashboard = autoStartPhalaka(ctx.args);
      if (dashboard.status === 'already_running') {
        console.log(`phalaka: already running (pid ${dashboard.pid})`);
        console.log(`Dashboard: ${dashboard.url}`);
      } else if (dashboard.status === 'started') {
        console.log(`phalaka: started (pid ${dashboard.pid})`);
        console.log(`Dashboard: ${dashboard.url}`);
      }
    },
  },
  {
    name: 'stop',
    summary: 'Stop worker daemons (and the phalaka dashboard) for registered kshetras',
    usage: '[--kshetra <id>]',
    run(ctx) {
      const id = ctx.flag('--kshetra');
      const registry = loadRegistry();
      const targets = id ? registry.filter(k => k.id === id) : registry;
      if (id && targets.length === 0) {
        throw new Error(`Kshetra not found: ${id}`);
      }
      for (const k of targets) {
        const result = stopWorker(k.id);
        if (result.status === 'stopped') {
          console.log(`${k.id}: stopped (pid ${result.pid})`);
        } else if (result.status === 'stale_pid_cleared') {
          console.log(`${k.id}: was not running (stale PID file cleared)`);
        } else {
          console.log(`${k.id}: not running`);
        }
      }
      const dashboard = autoStopPhalaka(ctx.args);
      if (dashboard.status === 'stopped') {
        console.log(`phalaka: stopped (pid ${dashboard.pid})`);
      } else if (dashboard.status === 'stale_pid_cleared') {
        console.log('phalaka: was not running (stale PID file cleared)');
      }
    },
  },
  {
    name: 'status',
    summary: 'Show status of the current (or all) kshetras',
    usage: '[--all]',
    run(ctx) {
      return runStatus({ all: ctx.has('--all'), cwd: process.cwd() });
    },
  },
  {
    name: 'pause',
    summary: 'Pause a kshetra so its daemon stops picking new tasks',
    usage: '--kshetra <id>',
    run(ctx) {
      const id = ctx.flag('--kshetra');
      if (!id) throw new Error('Usage: shreni pause --kshetra <id>');
      const result = pauseKshetraById(id);
      if (result.status === 'not_found') {
        throw new Error(`Kshetra not found: ${id}`);
      }
      console.log(`Kshetra "${id}" paused — daemon will stop picking tasks on next cycle`);
    },
  },
  {
    name: 'resume',
    summary: 'Resume a paused kshetra (recovering any hung agent)',
    usage: '--kshetra <id>',
    run(ctx) {
      const id = ctx.flag('--kshetra');
      if (!id) throw new Error('Usage: shreni resume --kshetra <id>');
      const result = resumeKshetraById(id);
      if (result.status === 'not_found') {
        throw new Error(`Kshetra not found: ${id}`);
      } else if (result.status === 'resumed_self_heal') {
        console.log(`Kshetra "${id}" resumed — worker is recovering the hung agent in-process`);
        console.log('(aborting it, reconciling the work tree, and re-arming pickup).');
      } else if (result.status === 'resumed_needs_start') {
        console.log(`Kshetra "${id}" un-paused, but no worker is running to recover the`);
        console.log('stuck bead. Start it to reconcile and resume work:');
        console.log(`  ${result.hint}`);
      } else {
        console.log(`Kshetra "${id}" resumed — daemon will pick tasks on next cycle`);
      }
    },
  },
  {
    name: 'base-branch',
    summary: 'Create the configured base branch on origin for a kshetra paused because it is missing, then resume it',
    usage: 'create <id>',
    async run(ctx) {
      const sub = ctx.args[0];
      if (sub !== 'create') {
        throw new Error('Usage: shreni base-branch create <id>');
      }
      const id = ctx.args[1];
      if (!id) throw new Error('Usage: shreni base-branch create <id>');

      const result = await createBaseBranchForKshetra(id);
      switch (result.status) {
        case 'not_found':
          throw new Error(`Kshetra not found: ${id}`);
        case 'not_paused_for_missing_base':
          // Graceful no-op (exit 0): the operator asked to clear a missing-base
          // pause that isn't in effect. Don't touch an unrelated pause.
          console.log(
            result.reason
              ? `Kshetra "${id}" is paused for "${result.reason}", not a missing base branch — nothing to do.`
              : `Kshetra "${id}" is not paused for a missing base branch — nothing to do.`,
          );
          break;
        case 'already_exists':
          console.log(`Base branch "${result.branch}" already exists on origin — resumed kshetra "${id}".`);
          break;
        case 'created':
          console.log(`Created origin/${result.branch} from origin/${result.base} and resumed kshetra "${id}".`);
          break;
      }
    },
  },
  {
    name: 'agents',
    summary: 'List currently running agents across kshetras',
    run() {
      return runAgents();
    },
  },
  {
    name: 'logs',
    summary: 'Show per-bead agent logs for a kshetra',
    usage: '[--kshetra <id>] [--bead <id>] [--all]',
    run(ctx) {
      return runLogs({
        kshetraId: ctx.flag('--kshetra'),
        beadId: ctx.flag('--bead'),
        all: ctx.has('--all'),
      });
    },
  },
  {
    name: 'run',
    summary: 'Work at most one cycle for a kshetra — an alias for `drain --max-cycles 1` (same worker runtime, ledger, exit codes)',
    usage: RUN_USAGE,
    run(ctx) {
      if (wantsHelp(ctx)) { console.log(RUN_HELP); return; }
      // A thin alias, NOT a second execution path (Shreni-beads-nhw): exactly one
      // drain cycle through the real worker runtime. Only --label,
      // --allow-ablation and --json are forwarded (drain-only flags are refused);
      // the lot records entrypoint 'run' so one-cycle lots stay distinguishable.
      const id = ctx.flag('--kshetra');
      if (!id) throw new Error(`Usage: shreni run ${RUN_USAGE}\n${RUN_HELP}`);
      // Refuse drain-only flags rather than silently running an unscoped cycle.
      for (const f of ['--epic', '--max-cycles']) {
        if (ctx.has(f)) throw new Error(`shreni run does not take ${f} — use \`shreni drain ${f} …\` instead.`);
      }
      return drainAndExit(ctx, id, { maxCycles: 1, entrypoint: 'run' });
    },
  },
  {
    name: 'drain',
    summary: 'Run the worker in the foreground until every ready bead is worked (or --max-cycles is reached), then exit with a reason',
    usage: DRAIN_USAGE,
    run(ctx) {
      if (wantsHelp(ctx)) { console.log(`Usage: shreni drain ${DRAIN_USAGE}\n${DRAIN_EXIT_CODES}`); return; }
      const id = ctx.flag('--kshetra');
      if (!id) throw new Error(`Usage: shreni drain ${DRAIN_USAGE}`);
      return drainAndExit(ctx, id, {
        epic: ctx.flag('--epic'),
        maxCycles: parseMaxCycles(ctx),
      });
    },
  },
  {
    name: 'freeze',
    summary: 'Snapshot a kshetra\'s complete state (beads, runtime, flags, RAG) with a verifiable manifest',
    usage: '--kshetra <id> --out <dir|parent> [--label key=value ...] [--force] [--json]',
    run(ctx) {
      return runFreeze(ctx);
    },
  },
  {
    name: 'snapshots',
    summary: 'List freeze snapshots under a parent directory (newest first, with counts, labels, build, and shared-state markers)',
    usage: 'list <parent> [--kshetra <id>] [--json]',
    run(ctx) {
      return runSnapshots(ctx);
    },
  },
  {
    name: 'export',
    summary: 'Export a kshetra\'s bead graph as a deterministic, topologically ordered markdown file (refuses executed beads — they leak the answers — unless --allow-executed)',
    usage: '--kshetra <id> [--epic <id>] [--format md] [--snapshot <dir>] [--with-context] [--allow-executed] --out <file>',
    run(ctx) {
      return runExport(ctx);
    },
  },
  {
    name: 'restore',
    summary: 'Restore a kshetra from a freeze snapshot (archive-first, delete-then-copy, verified)',
    usage: '--kshetra <id> --from <dir|parent> [--latest] --yes [--clean] [--archive <dir>]',
    run(ctx) {
      return runRestore(ctx);
    },
  },
  {
    name: 'sync',
    summary: 'Sync the beads database (git pull + push) for the current (or all) kshetras',
    usage: '[--kshetra <id>] [--all]',
    run(ctx) {
      return runSync({ kshetraId: ctx.flag('--kshetra'), all: ctx.has('--all') });
    },
  },
  {
    name: 'init',
    summary: 'Onboard a repo in one step (prompts for slug/path, then scaffolds the kshetra)',
    usage: '[--slug <id>] [--path <repo-path>] [--provider claude|codex|gemini] [--model <id>] [--org <org>] [--language <lang>] [--beads-path <path>] [--merge-policy push|pr] [--pack <name>] [--no-pack] [--upgrade] [--dry-run]',
    run(ctx) {
      const mergePolicy = ctx.flag('--merge-policy');
      if (mergePolicy && mergePolicy !== 'push' && mergePolicy !== 'pr') {
        throw new Error(`Invalid --merge-policy "${mergePolicy}": expected "push" or "pr".`);
      }
      return runInit({
        slug: ctx.flag('--slug'),
        path: ctx.flag('--path'),
        org: ctx.flag('--org'),
        language: ctx.flag('--language'),
        beadsPath: ctx.flag('--beads-path'),
        provider: ctx.flag('--provider'),
        model: ctx.flag('--model'),
        mergePolicy: (mergePolicy as 'push' | 'pr' | undefined) ?? undefined,
        dryRun: ctx.has('--dry-run'),
        pack: ctx.flag('--pack') ?? undefined,
        noPack: ctx.has('--no-pack'),
        upgrade: ctx.has('--upgrade'),
      });
    },
  },
  {
    name: 'init-kshetra',
    summary: 'Scaffold and register a new kshetra from a repo path',
    usage: '--slug <id> --path <repo-path> [--org <org>] [--language <lang>] [--beads-path <path>] [--provider claude|codex|gemini] [--model <id>] [--merge-policy push|pr] [--pack <name>] [--no-pack] [--upgrade] [--dry-run]',
    run(ctx) {
      const slug = ctx.flag('--slug');
      const path = ctx.flag('--path');
      const org = ctx.flag('--org');
      const language = ctx.flag('--language');
      const beadsPath = ctx.flag('--beads-path');
      const provider = ctx.flag('--provider');
      const model = ctx.flag('--model');
      const mergePolicy = ctx.flag('--merge-policy');
      const dryRun = ctx.has('--dry-run');
      if (!slug || !path) {
        throw new Error('Usage: shreni init-kshetra --slug <id> --path <repo-path> [--org <org>] [--language <lang>] [--beads-path <path>] [--provider claude|codex|gemini] [--model <id>] [--merge-policy push|pr] [--dry-run]');
      }
      if (mergePolicy && mergePolicy !== 'push' && mergePolicy !== 'pr') {
        throw new Error(`Invalid --merge-policy "${mergePolicy}": expected "push" or "pr".`);
      }
      return initKshetra({
        slug, path, org, language,
        beadsPath: beadsPath ?? undefined,
        provider: provider ?? undefined,
        model: model ?? undefined,
        mergePolicy: (mergePolicy as 'push' | 'pr' | null) ?? undefined,
        dryRun,
        pack: ctx.flag('--pack') ?? undefined,
        noPack: ctx.has('--no-pack'),
        upgrade: ctx.has('--upgrade'),
      });
    },
  },
  {
    name: 'telemetry',
    summary: 'View or change anonymous telemetry consent',
    usage: '<status|enable|disable>',
    run(ctx) {
      runTelemetry(ctx.args[0]);
    },
  },
  {
    name: 'register',
    summary: 'Register an existing kshetra config by path',
    usage: '<path>',
    run(ctx) {
      const kshetraPath = ctx.args[0];
      if (!kshetraPath) throw new Error('Usage: shreni register <path>');
      const result = runRegister(kshetraPath);
      console.log(`Kshetra "${result.id}" registered (${result.configPath})`);
    },
  },
  {
    name: 'migrate',
    summary: 'Migrate a legacy kshetra config to the canonical location',
    usage: '<path>',
    run(ctx) {
      const kshetraPath = ctx.args[0];
      if (!kshetraPath) throw new Error('Usage: shreni migrate <path>');
      const result = runMigrate(kshetraPath);
      switch (result.status) {
        case 'migrated':
          console.log(`Migrated config to ${result.configPath}${result.id ? ` (kshetra "${result.id}" re-registered)` : ''}`);
          break;
        case 'already_canonical':
          console.log(`Already canonical: ${result.configPath} — nothing to migrate`);
          break;
        case 'nothing_to_migrate':
          throw new Error(`No config found to migrate at ${kshetraPath}`);
      }
      // 4a2.7: report the beads-repo interactions.jsonl un-ignore outcome.
      if (result.interactions === 'changed') {
        console.log('Beads repo now tracks interactions.jsonl (removed the gitignore entry).');
      }
    },
  },
  {
    name: 'list',
    summary: 'List all registered kshetras',
    run() {
      runList();
    },
  },
  {
    name: 'verify-hooks',
    summary: 'Verify the required beads hooks are installed',
    run() {
      const result = verifyHooks();
      const ok = (v: boolean) => v ? '✓' : '✗';
      console.log(`SessionStart hook (bd prime): ${ok(result.sessionStart.present)}`);
      console.log(`PreCompact hook  (bd prime): ${ok(result.preCompact.present)}`);
      if (!result.allPresent) {
        throw new Error('\nOne or more hooks missing. Run `bd setup claude` in your Kshetra to install them.');
      }
    },
  },
  {
    name: 'phalaka',
    summary: 'Control the phalaka dashboard server',
    usage: '<start|stop|status> [--port <port>]',
    run(ctx) {
      const sub = ctx.args[0];
      const port = ctx.flag('--port');
      const parsedPort = port ? parseInt(port, 10) : undefined;

      if (sub === 'start') {
        const result = startPhalaka(parsedPort);
        if (result.status === 'already_running') {
          console.log(`phalaka is already running (pid ${result.pid})`);
        } else {
          console.log(`phalaka started (pid ${result.pid})`);
        }
        console.log(`Dashboard: ${result.url}`);
      } else if (sub === 'stop') {
        const result = stopPhalaka();
        if (result.status === 'stopped') {
          console.log(`phalaka stopped (pid ${result.pid})`);
        } else if (result.status === 'stale_pid_cleared') {
          console.log('phalaka was not running (stale PID file cleared)');
        } else {
          console.log('phalaka is not running');
        }
      } else if (sub === 'status') {
        const result = statusPhalaka(parsedPort);
        if (result.running) {
          console.log(`phalaka running (pid ${result.pid})`);
          console.log(`Dashboard: ${result.url}`);
        } else {
          console.log('phalaka is not running');
        }
      } else {
        throw new Error('Usage: shreni phalaka <start|stop|status> [--port <port>]');
      }
    },
  },
  {
    name: 'suthradhara',
    summary: 'Control a Suthradhara interview session for a kshetra',
    usage: '<start|resume <session-id>|stop|status|list> [@<id> | --kshetra <id>]',
    run(ctx) {
      return runSuthradhara(ctx.args[0], {
        args: ctx.args.slice(1),
        flagKshetra: ctx.flag('--kshetra'),
        cwd: process.cwd(),
      });
    },
  },
  {
    name: 'tail',
    summary: 'Tail the live worker log for the current (or all) kshetras',
    usage: '[--kshetra <id>] [--all]',
    run(ctx) {
      runTail({ kshetraId: ctx.flag('--kshetra'), all: ctx.has('--all') });
    },
  },
  {
    name: 'report',
    summary: 'Print a terminal table of run metrics (tasks, review quality, tokens, cost) for a kshetra',
    usage: '[@<id> | --kshetra <id>] [--turns] [--json]',
    run(ctx) {
      return runReport({
        args: ctx.args,
        flagKshetra: ctx.flag('--kshetra'),
        cwd: process.cwd(),
        // --turns: emit the per-turn context series as JSONL (epic 408/A1) instead
        // of the table. Takes precedence over --json.
        turns: ctx.has('--turns'),
        // --json: emit the full metrics (incl. the per-lot time breakdown, epic hto)
        // as one JSON object for the study driver.
        json: ctx.has('--json'),
      });
    },
  },
  {
    name: 'show',
    summary: 'Join a bead\'s plan (bd) and execution (ledger) into one timeline',
    usage: '<beadId> [@<id> | --kshetra <id>]',
    run(ctx) {
      return runShow({
        args: ctx.args,
        flagKshetra: ctx.flag('--kshetra'),
        cwd: process.cwd(),
      });
    },
  },
  {
    name: 'help',
    summary: 'Show this help',
    run() {
      console.log(renderHelp(COMMANDS));
    },
  },
];