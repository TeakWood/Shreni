// Session-transcript token-usage reader (epic fnd.3). The launched planning
// session runs interactive (no `-p`, no stream-json), so the executor's usage
// path — parse the headless `result` message — does not apply. Instead, because
// the launch pins `--session-id <uuid>`, Claude Code writes a transcript JSONL to
// a known location; this reader sums the per-message usage blocks so fnd.4 can
// feed the same getUsageMeter().record() seam the executors use.
//
// DEFENSIVE BY DESIGN: the transcript is a Claude-Code-INTERNAL format (a softer
// contract than the `-p` result message, and a candidate to break across CLI
// versions). A missing/rotated/renamed file or a malformed line yields zeros/skip
// and a warning — never a throw.

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TokenUsage } from '../agents/providers/types.js';

// TokenUsage plus the tool-call count, mirroring what the executor path records.
export interface SessionUsage extends TokenUsage {
  toolCallCount: number;
}

const ZERO: SessionUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0,
};

// The default Claude Code projects root. Injectable so tests point at a fixture.
export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

// Slugify a cwd into Claude Code's project-dir name: every character that is not a
// letter, digit, or hyphen becomes '-'. Observed:
//   /Users/x/projects/Shreni        -> -Users-x-projects-Shreni
//   /Users/x/.shreni-worktrees/y    -> -Users-x--shreni-worktrees-y   ('.' and '/' both -> '-')
// This is a soft, CLI-internal contract; if it drifts, the transcript simply
// isn't found and usage reads as zero (readSessionUsage below).
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

// Locate the transcript for a pinned session id run under `cwd`.
export function transcriptPath(cwd: string, claudeSessionId: string, root = defaultProjectsRoot()): string {
  return join(root, projectSlug(cwd), `${claudeSessionId}.jsonl`);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Sum the token usage + tool-call count of an interactive session from its
// transcript. Each assistant line carries `message.usage` (Anthropic's token
// block, same field names the executor adapter reads) and `message.content[]`
// whose `tool_use` blocks are the tool calls. Missing file / malformed lines are
// tolerated (zeros / skip + warning).
export function readSessionUsage(
  cwd: string,
  claudeSessionId: string,
  root = defaultProjectsRoot(),
): SessionUsage {
  const path = transcriptPath(cwd, claudeSessionId, root);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.warn(`[suthradhara] session transcript not found at ${path} — recording zero usage`);
    return { ...ZERO };
  }

  const total: SessionUsage = { ...ZERO };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // skip a malformed/half-written line rather than fail the read
    }
    if (obj.type !== 'assistant') continue;
    const message = obj.message;
    if (!message || typeof message !== 'object') continue;
    const m = message as Record<string, unknown>;

    const u = m.usage;
    if (u && typeof u === 'object') {
      const usage = u as Record<string, unknown>;
      total.inputTokens += num(usage.input_tokens);
      total.outputTokens += num(usage.output_tokens);
      total.cacheReadTokens += num(usage.cache_read_input_tokens);
      total.cacheCreationTokens += num(usage.cache_creation_input_tokens);
    }

    const content = m.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
          total.toolCallCount++;
        }
      }
    }
  }
  return total;
}
