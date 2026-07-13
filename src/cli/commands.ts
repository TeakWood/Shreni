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
import { runAgents } from './agents';
import { runLogs } from './logs';
import { runRun } from './run';
import { runSync } from './sync';
import { initKshetra } from './init-kshetra';
import { runRegister } from './register';
import { runMigrate } from './migrate';
import { verifyHooks } from './verify-hooks';
import { runList } from './list';
import { startPhalaka, stopPhalaka, statusPhalaka } from './phalaka';
import { autoStartPhalaka, autoStopPhalaka } from './phalaka-autostart';
import { runTail } from './tail';
import { runInit } from './init';
import { runTelemetry } from './telemetry';
import { emit as emitTelemetry } from '../telemetry/telemetry';

export const COMMANDS: Command[] = [
  {
    name: 'start',
    summary: 'Start worker daemons (and the phalaka dashboard) for registered kshetras',
    usage: '[--kshetra <id>]',
    run(ctx) {
      const id = ctx.flag('--kshetra');
      const registry = loadRegistry();
      const targets = id ? registry.filter(k => k.id === id) : registry;
      if (registry.length === 0) {
        throw new Error('No kshetras registered. Run `shreni register` first.');
      }
      if (id && targets.length === 0) {
        throw new Error(`Kshetra not found: ${id}`);
      }
      for (const k of targets) {
        const result = startWorker(k.id);
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
    summary: 'Run a single manual work cycle for a kshetra',
    usage: '--kshetra <id>',
    run(ctx) {
      const id = ctx.flag('--kshetra');
      if (!id) throw new Error('Usage: shreni run --kshetra <id>');
      return runRun(id);
    },
  },
  {
    name: 'sync',
    summary: 'Sync the RAG index for the current (or all) kshetras',
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
    name: 'tail',
    summary: 'Tail the live worker log for the current (or all) kshetras',
    usage: '[--kshetra <id>] [--all]',
    run(ctx) {
      runTail({ kshetraId: ctx.flag('--kshetra'), all: ctx.has('--all') });
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