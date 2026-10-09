import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { PRIME } from '../policy/init/instructions';

// The hooks `shreni task setup` installs: shreni task prime at session start
// and before compaction. They live in the repo's .claude/settings.json; a
// user-wide one in ~/.claude/settings.json counts too.
export const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
export const REQUIRED_COMMAND = PRIME;

/** Where the hooks may be: the repo's settings, then the user's. */
export const settingsPaths = (repo = process.cwd()): string[] => [join(repo, '.claude', 'settings.json'), SETTINGS_PATH];

interface HookEntry {
  type?: string;
  command?: string;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookMatcher[];
    PreCompact?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
}

export interface HookCheckResult {
  present: boolean;
}

export interface HooksVerificationResult {
  sessionStart: HookCheckResult;
  preCompact: HookCheckResult;
  allPresent: boolean;
}

function hasHook(matchers: HookMatcher[] | undefined, command: string): boolean {
  if (!Array.isArray(matchers)) return false;
  return matchers.some(
    m => Array.isArray(m?.hooks) && m.hooks.some(h => h.command?.trim() === command),
  );
}

function readSettings(settingsPath: string): ClaudeSettings {
  try {
    const raw = readFileSync(resolve(settingsPath), 'utf8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw new Error(`Cannot read settings at ${settingsPath}: ${e.message}`);
    return {};
  }
}

/** Whether each hook runs shreni task prime, in any of the settings files. */
export function verifyHooks(paths: string | string[] = settingsPaths()): HooksVerificationResult {
  const all = (Array.isArray(paths) ? paths : [paths]).map(readSettings);
  const sessionStart: HookCheckResult = {
    present: all.some(s => hasHook(s.hooks?.SessionStart, REQUIRED_COMMAND)),
  };
  const preCompact: HookCheckResult = {
    present: all.some(s => hasHook(s.hooks?.PreCompact, REQUIRED_COMMAND)),
  };

  return {
    sessionStart,
    preCompact,
    allPresent: sessionStart.present && preCompact.present,
  };
}