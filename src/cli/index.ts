#!/usr/bin/env node
import { startDaemon } from './start';
import { stopDaemon } from './stop';
import { runStatus } from './status';

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

  default:
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: shreni <start|stop|status [--all]>');
    process.exit(1);
}

void args;