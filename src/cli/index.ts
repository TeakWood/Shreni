#!/usr/bin/env node
import { COMMANDS } from './commands';
import { dispatch } from './registry';
import { cliArgs } from './self-exec';

const args = cliArgs();
const [sub, ...subArgs] = args;

// Hidden self-exec subcommands (Shreni-beads-lbx): the standalone binary
// re-invokes itself with these instead of spawning `node worker.js` /
// `node phalaka-server.js`, since a SEA binary has no sibling scripts on disk.
// They are NOT registered in COMMANDS, so they never appear in `shreni help`.
if (sub === '__worker') {
  // worker.ts reads the kshetra id from process.argv[2]; normalize argv so it
  // lands there regardless of the node-vs-binary launch offset.
  process.argv = [process.argv[0], process.argv[1] ?? '', subArgs[0] ?? ''];
  require('./worker');
} else if (sub === '__phalaka-server') {
  require('./phalaka-server'); // reads PHALAKA_PORT from the environment
} else {
  dispatch(args, COMMANDS).then((code) => {
    // Only exit explicitly on failure; success paths return 0 and let the
    // process end naturally (so detached workers spawned by `start` aren't
    // torn down).
    if (code !== 0) process.exit(code);
  });
}