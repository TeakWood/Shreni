import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

export const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
export const REQUIRED_COMMAND = 'bd prime';

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
    m => Array.isArray(m?.hooks) && m.hooks.some(h => h.command === command),
  );
}

export function verifyHooks(settingsPath = SETTINGS_PATH): HooksVerificationResult {
  let settings: ClaudeSettings = {};
  try {
    const raw = readFileSync(resolve(settingsPath), 'utf8');
    settings = JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw new Error(`Cannot read settings at ${settingsPath}: ${e.message}`);
  }

  const sessionStart: HookCheckResult = {
    present: hasHook(settings.hooks?.SessionStart, REQUIRED_COMMAND),
  };
  const preCompact: HookCheckResult = {
    present: hasHook(settings.hooks?.PreCompact, REQUIRED_COMMAND),
  };

  return {
    sessionStart,
    preCompact,
    allPresent: sessionStart.present && preCompact.present,
  };
}