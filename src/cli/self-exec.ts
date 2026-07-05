// Launching the CLI as a child process — correct under both `node` (dev / npm
// install) and a Node SEA standalone binary (Shreni-beads-lbx).
//
// In a SEA there are no sibling .js files on disk and process.execPath is the
// binary itself, so worker/phalaka children are launched by re-invoking the
// binary with a hidden subcommand (`__worker` / `__phalaka-server`) rather than
// `node worker.js`. Node pads a SEA's argv[1] with the exec path (so existing
// argv.slice(2) code keeps working), which is why cliApp args slice at 2 in both
// modes but selfExec still omits the script-path slot when spawning a SEA.

export interface Launch {
  command: string;
  args: string[];
}

// True when running as a Node Single Executable Application.
export function isStandaloneBinary(): boolean {
  try {
    // node:sea ships on Node >=20.12; isSea() is true only inside a SEA build.
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

// The user-supplied CLI arguments. Node pads a SEA's argv[1] with the exec path
// too, so slice(2) is correct under BOTH node and a standalone binary.
export function cliArgs(argv: string[] = process.argv): string[] {
  return argv.slice(2);
}

// Command+args to re-invoke this CLI with a hidden subcommand:
//   SEA binary: <binary> <sub> [args…]
//   under node: <node> <this-entry-script> <sub> [args…]
export function selfExec(sub: string, args: string[] = [], sea: boolean = isStandaloneBinary()): Launch {
  if (sea) {
    return { command: process.execPath, args: [sub, ...args] };
  }
  return { command: process.execPath, args: [process.argv[1] ?? '', sub, ...args] };
}