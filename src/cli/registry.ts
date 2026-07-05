// Homegrown, dependency-free command registry + dispatcher for the `shreni` CLI.
//
// Each command lives in its own module and exports a `Command` descriptor
// (name, summary, an optional usage hint, and a `run`). The dispatcher resolves
// argv -> command, hands it a `CommandContext` (flag/positional helpers), and
// centralizes the two things every command used to hand-roll: unknown-command
// handling and a uniform "on error, print message and exit 1". `shreni help`
// (and an unknown/absent command) prints usage generated FROM the registry, so
// it can never drift from the commands that actually exist.

export interface CommandContext {
  /** Arguments after the command name, e.g. `['--kshetra', 'foo']`. */
  args: string[];
  /** Value following `name`, or undefined. `flag('--kshetra')` -> 'foo'. */
  flag(name: string): string | undefined;
  /** Whether a bare flag is present. `has('--all')` -> true/false. */
  has(name: string): boolean;
}

export interface Command {
  /** The subcommand token, e.g. `status`. */
  name: string;
  /** One-line description shown in generated help. */
  summary: string;
  /** Argument hint shown after the name in help, e.g. `--kshetra <id>`. */
  usage?: string;
  /**
   * Execute the command. May be sync or async. Throw an Error to signal
   * failure — the dispatcher prints its message to stderr and exits non-zero,
   * so commands never call process.exit themselves.
   */
  run(ctx: CommandContext): void | Promise<void>;
}

export function makeContext(args: string[]): CommandContext {
  return {
    args,
    flag(name: string): string | undefined {
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    has(name: string): boolean {
      return args.includes(name);
    },
  };
}

/**
 * Build the multi-line usage text for `shreni help` from the registry.
 * Summaries align on the command-name column; each command's (possibly long)
 * usage hint trails its summary so one verbose command can't blow out the
 * alignment for everything else.
 */
export function renderHelp(commands: Command[]): string {
  const nameWidth = Math.max(...commands.map(c => c.name.length));
  const lines = commands.map(c => {
    const left = `  shreni ${c.name.padEnd(nameWidth)}`;
    const usage = c.usage ? `  ${c.usage}` : '';
    return `${left}  ${c.summary}${usage}`;
  });
  return ['Usage: shreni <command> [options]', '', 'Commands:', ...lines].join('\n');
}

/** Names the dispatcher treats as an explicit help request. */
const HELP_ALIASES = new Set(['help', '--help', '-h']);

/**
 * Resolve and run a command. Returns the process exit code; the caller owns
 * the actual process.exit so this stays unit-testable.
 *
 * - explicit help -> print generated help to stdout, code 0
 * - no command / unknown command -> print help to stderr, code 1
 * - command throws -> print its message to stderr, code 1
 */
export async function dispatch(argv: string[], commands: Command[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name !== undefined && HELP_ALIASES.has(name)) {
    console.log(renderHelp(commands));
    return 0;
  }

  const command = commands.find(c => c.name === name);
  if (!command) {
    console.error(`Unknown command: ${name ?? '(none)'}`);
    console.error(renderHelp(commands));
    return 1;
  }

  try {
    await command.run(makeContext(rest));
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}