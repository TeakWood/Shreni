#!/usr/bin/env node
import { COMMANDS } from './commands';
import { dispatch } from './registry';

dispatch(process.argv.slice(2), COMMANDS).then((code) => {
  // Only exit explicitly on failure; success paths return 0 and let the process
  // end naturally (so detached workers spawned by `start` aren't torn down).
  if (code !== 0) process.exit(code);
});