#!/usr/bin/env node
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

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'start': {
    const id = parseFlag(args, '--kshetra');
    const registry = loadRegistry();
    const targets = id ? registry.filter(k => k.id === id) : registry;
    if (registry.length === 0) {
      console.error('No kshetras registered. Run `shreni register` first.');
      process.exit(1);
    } else if (id && targets.length === 0) {
      console.error(`Kshetra not found: ${id}`);
      process.exit(1);
    } else {
      for (const k of targets) {
        const result = startWorker(k.id);
        if (result.status === 'already_running') {
          console.log(`${k.id}: already running (pid ${result.pid})`);
        } else {
          console.log(`${k.id}: started (pid ${result.pid})`);
        }
      }
      const dashboard = autoStartPhalaka(args);
      if (dashboard.status === 'already_running') {
        console.log(`phalaka: already running (pid ${dashboard.pid})`);
        console.log(`Dashboard: ${dashboard.url}`);
      } else if (dashboard.status === 'started') {
        console.log(`phalaka: started (pid ${dashboard.pid})`);
        console.log(`Dashboard: ${dashboard.url}`);
      }
    }
    break;
  }

  case 'stop': {
    const id = parseFlag(args, '--kshetra');
    const registry = loadRegistry();
    const targets = id ? registry.filter(k => k.id === id) : registry;
    if (id && targets.length === 0) {
      console.error(`Kshetra not found: ${id}`);
      process.exit(1);
    } else {
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
      const dashboard = autoStopPhalaka(args);
      if (dashboard.status === 'stopped') {
        console.log(`phalaka: stopped (pid ${dashboard.pid})`);
      } else if (dashboard.status === 'stale_pid_cleared') {
        console.log('phalaka: was not running (stale PID file cleared)');
      }
    }
    break;
  }

  case 'status': {
    const all = args.includes('--all');
    runStatus({ all, cwd: process.cwd() }).catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
    break;
  }

  case 'pause': {
    const id = parseFlag(args, '--kshetra');
    if (!id) { console.error('Usage: shreni pause --kshetra <id>'); process.exit(1); }
    else {
      const result = pauseKshetraById(id);
      if (result.status === 'not_found') {
        console.error(`Kshetra not found: ${id}`); process.exit(1);
      } else {
        console.log(`Kshetra "${id}" paused — daemon will stop picking tasks on next cycle`);
      }
    }
    break;
  }

  case 'resume': {
    const id = parseFlag(args, '--kshetra');
    if (!id) { console.error('Usage: shreni resume --kshetra <id>'); process.exit(1); }
    else {
      const result = resumeKshetraById(id);
      if (result.status === 'not_found') {
        console.error(`Kshetra not found: ${id}`); process.exit(1);
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
    }
    break;
  }

  case 'agents': {
    runAgents().catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
    break;
  }

  case 'logs': {
    const kshetraId = parseFlag(args, '--kshetra');
    const beadId = parseFlag(args, '--bead');
    const all = args.includes('--all');
    runLogs({ kshetraId, beadId, all }).catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
    break;
  }

  case 'run': {
    const id = parseFlag(args, '--kshetra');
    if (!id) { console.error('Usage: shreni run --kshetra <id>'); process.exit(1); }
    else {
      runRun(id).catch((err: unknown) => {
        console.error((err as Error).message);
        process.exit(1);
      });
    }
    break;
  }

  case 'sync': {
    const kshetraId = parseFlag(args, '--kshetra');
    const all = args.includes('--all');
    runSync({ kshetraId, all }).catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
    break;
  }

  case 'init-kshetra': {
    const slug = parseFlag(args, '--slug');
    const path = parseFlag(args, '--path');
    const org = parseFlag(args, '--org');
    const language = parseFlag(args, '--language');
    const beadsPath = parseFlag(args, '--beads-path');
    const provider = parseFlag(args, '--provider');
    const model = parseFlag(args, '--model');
    const mergePolicy = parseFlag(args, '--merge-policy');
    const dryRun = args.includes('--dry-run');
    if (!slug || !path) {
      console.error('Usage: shreni init-kshetra --slug <id> --path <repo-path> [--org <org>] [--language <lang>] [--beads-path <path>] [--provider claude|codex|gemini] [--model <id>] [--merge-policy push|pr] [--dry-run]');
      process.exit(1);
    } else if (mergePolicy && mergePolicy !== 'push' && mergePolicy !== 'pr') {
      console.error(`Invalid --merge-policy "${mergePolicy}": expected "push" or "pr".`);
      process.exit(1);
    } else {
      initKshetra({
        slug, path, org, language,
        beadsPath: beadsPath ?? undefined,
        provider: provider ?? undefined,
        model: model ?? undefined,
        mergePolicy: (mergePolicy as 'push' | 'pr' | null) ?? undefined,
        dryRun,
      }).catch((err: unknown) => {
        console.error((err as Error).message);
        process.exit(1);
      });
    }
    break;
  }

  case 'register': {
    const kshetraPath = args[0];
    if (!kshetraPath) {
      console.error('Usage: shreni register <path>');
      process.exit(1);
    } else {
      try {
        const result = runRegister(kshetraPath);
        console.log(`Kshetra "${result.id}" registered (${result.configPath})`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }
    break;
  }

  case 'migrate': {
    const kshetraPath = args[0];
    if (!kshetraPath) {
      console.error('Usage: shreni migrate <path>');
      process.exit(1);
    } else {
      try {
        const result = runMigrate(kshetraPath);
        switch (result.status) {
          case 'migrated':
            console.log(`Migrated config to ${result.configPath}${result.id ? ` (kshetra "${result.id}" re-registered)` : ''}`);
            break;
          case 'already_canonical':
            console.log(`Already canonical: ${result.configPath} — nothing to migrate`);
            break;
          case 'nothing_to_migrate':
            console.error(`No config found to migrate at ${kshetraPath}`);
            process.exit(1);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }
    break;
  }

  case 'list': {
    runList();
    break;
  }

  case 'verify-hooks': {
    const result = verifyHooks();
    const ok = (v: boolean) => v ? '✓' : '✗';
    console.log(`SessionStart hook (bd prime): ${ok(result.sessionStart.present)}`);
    console.log(`PreCompact hook  (bd prime): ${ok(result.preCompact.present)}`);
    if (!result.allPresent) {
      console.error('\nOne or more hooks missing. Run `bd setup claude` in your Kshetra to install them.');
      process.exit(1);
    }
    break;
  }

  case 'phalaka': {
    const sub = args[0];
    const port = parseFlag(args.slice(1), '--port');
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
      console.error('Usage: shreni phalaka <start|stop|status> [--port <port>]');
      process.exit(1);
    }
    break;
  }

  case 'tail': {
    const kshetraId = parseFlag(args, '--kshetra');
    const all = args.includes('--all');
    runTail({ kshetraId, all });
    break;
  }

  default:
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: shreni <start|stop> [--kshetra <id>]');
    console.error('       shreni <status|agents|logs|pause|resume|run|sync|init-kshetra|register|migrate|verify-hooks|phalaka|tail>');
    process.exit(1);
}
