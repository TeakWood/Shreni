#!/usr/bin/env node
import { startDaemon } from './start';
import { stopDaemon } from './stop';

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

  default:
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: shreni <start|stop>');
    process.exit(1);
}

void args;