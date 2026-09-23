// Opaque run labels (epic yrk / Study B2, yrk.4). Repeatable `--label key=value`
// on `shreni start` / `shreni drain` / `shreni run` / the hidden `__worker` subcommand, recorded
// VERBATIM in the lot manifest's worker_started.labels. Shreni validates only the
// SHAPE and never interprets a label — it must never learn what 'arm' or 'rep'
// mean (decision 10). Labels also serve teams (e.g. change=CHG-1234).

const KEY_RE = /^[a-z0-9_.-]+$/;
const MAX_KEY = 64;
const MAX_VALUE = 256;

// Parse every `--label key=value` occurrence from a CLI arg list into a verbatim
// map. Throws a usage error on a malformed or duplicate label so the caller
// (`shreni start` / `run`) fails fast BEFORE any worker is spawned. No labels ->
// {}. Validation is shape-only: key matches [a-z0-9_.-]+, value non-empty, both
// bounded; nothing here (or anywhere) branches on a key or value.
export function parseLabels(args: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--label') continue;
    const raw = args[i + 1];
    i++; // consume the value slot
    // Missing value: `--label` at end of args, or immediately followed by another
    // flag (a well-formed value is `key=value`, never starts with `--`).
    if (raw === undefined || raw.startsWith('--')) {
      throw new Error('Usage: --label <key>=<value> — missing value.');
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --label "${raw}": expected <key>=<value>.`);
    }
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      throw new Error(`Invalid --label key "${key}": expected [a-z0-9_.-]+.`);
    }
    if (value.length === 0) {
      throw new Error(`Invalid --label "${raw}": value must be non-empty.`);
    }
    if (key.length > MAX_KEY || value.length > MAX_VALUE) {
      throw new Error(`Invalid --label "${key}": key must be ≤${MAX_KEY} and value ≤${MAX_VALUE} chars.`);
    }
    if (Object.prototype.hasOwnProperty.call(labels, key)) {
      throw new Error(`Duplicate --label key "${key}".`);
    }
    labels[key] = value;
  }
  return labels;
}

// Encode a (validated) label map back into repeatable `--label key=value` args,
// for threading through selfExec to the spawned worker, which re-parses them.
export function labelsToArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
}
