#!/usr/bin/env node
import { startDaemon } from './start';
import { stopDaemon } from './stop';
import { runStatus } from './status';
import { pauseKshetraById, resumeKshetraById } from './pause';
import { runAgents } from './agents';
import { runLogs } from './logs';

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'start': {
    const result = startDaemon();
    if (result.status === 'already_running') {
      console.log(`shreni is already running (pid ${result.pid})`);
    } else {
      console.log(`shreni started (pid ${result.pid})`);
    }
    break;
  }

  case 'stop': {
    const result = stopDaemon();
    if (result.status === 'stopped') {
      console.log(`shreni stopped (pid ${result.pid})`);
    } else if (result.status === 'stale_pid_cleared') {
      console.log('shreni was not running (stale PID file cleared)');
    } else {
      console.log('shreni is not running');
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

  default:
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: shreni <start|stop|status|agents|logs|pause|resume>');
    process.exit(1);
}
