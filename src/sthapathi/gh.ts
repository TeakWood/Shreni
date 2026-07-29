import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class GhError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

export interface PrState {
  // GitHub PR state as reported by `gh pr view`: OPEN | MERGED | CLOSED.
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
}

// One review event on the PR. GitHub review states we care about are
// CHANGES_REQUESTED (triggers follow-up) and APPROVED; COMMENTED/DISMISSED/
// PENDING pass through as-is. Inline comments are surfaced when present so the
// follow-up loop can feed them to Silpi as context (they arrive empty from a
// bare `gh pr view --json reviews` — gh does not expose review-thread comments
// there — but the shape is kept so a richer read can populate it later).
export interface PrReview {
  author: string | null;
  state: string;
  body: string;
  submittedAt: string | null;
  comments: PrComment[];
}

// A single inline (file/line) review comment.
export interface PrComment {
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
}

// One entry of the status-check rollup, normalised across gh's two shapes:
// CheckRun ({name, conclusion}) and legacy StatusContext ({context, state}).
// `conclusion` is null while a check is still pending/queued.
export interface PrCheck {
  name: string;
  conclusion: string | null;
}

// A commit on the PR head branch. `author` is the GitHub login when known —
// used to detect foreign commits (someone other than Shreni pushed).
export interface PrCommit {
  sha: string;
  author: string | null;
}

// The rich PR read backing the follow-up loop: everything `prView` returns plus
// the reviews / checks / commits needed to decide whether there is unaddressed
// feedback. Never surfaced to agents directly — Sthapathi reads it.
export interface PrStatus extends PrState {
  reviews: PrReview[];
  checks: PrCheck[];
  commits: PrCommit[];
}

// Raw `gh pr view --json` shapes (only the fields we read). gh uses `oid` for
// the commit sha and an `authors` array; statusCheckRollup mixes CheckRun and
// StatusContext members; reviews expose `author.login`.
interface RawReview {
  author?: { login?: string } | null;
  state?: string;
  body?: string;
  submittedAt?: string | null;
  comments?: { nodes?: RawComment[] } | RawComment[] | null;
}
interface RawComment {
  author?: { login?: string } | null;
  body?: string;
  path?: string | null;
  line?: number | null;
}
interface RawCheck {
  name?: string;
  context?: string;
  conclusion?: string | null;
  state?: string | null;
}
interface RawCommit {
  oid?: string;
  authors?: { login?: string }[] | null;
  author?: { login?: string } | null;
}

function parseReview(r: RawReview): PrReview {
  const rawComments = Array.isArray(r.comments)
    ? r.comments
    : (r.comments?.nodes ?? []);
  return {
    author: r.author?.login ?? null,
    state: r.state ?? 'COMMENTED',
    body: r.body ?? '',
    submittedAt: r.submittedAt ?? null,
    comments: rawComments.map((c) => ({
      author: c.author?.login ?? null,
      body: c.body ?? '',
      path: c.path ?? null,
      line: typeof c.line === 'number' ? c.line : null,
    })),
  };
}

function parseCheck(c: RawCheck): PrCheck | null {
  // CheckRun → {name, conclusion}; StatusContext → {context, state}.
  const name = c.name ?? c.context;
  if (!name) return null;
  const conclusion = c.conclusion ?? c.state ?? null;
  return { name, conclusion: conclusion ?? null };
}

function parseCommit(c: RawCommit): PrCommit {
  const author = c.authors?.[0]?.login ?? c.author?.login ?? null;
  return { sha: c.oid ?? '', author };
}

async function run(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new GhError('GH_ERROR', `gh ${args[0]} ${args[1] ?? ''} failed: ${e.stderr ?? e.message ?? String(err)}`, err);
  }
}

// Thin wrapper over the `gh` CLI, scoped to one repo working dir. Used only by
// the PR merge-policy path (3r2); `gh` is already a Shreni prerequisite and is
// used at init-kshetra time to create the beads repo.
export function gh(repoPath: string) {
  return {
    // Open a PR bead-branch → base. Idempotent: if a PR already exists for the
    // head branch, return its URL instead of failing (a re-dispatched or
    // recovered bead must not error on a PR that is already open).
    async prCreate(opts: { base: string; head: string; title: string; body: string }): Promise<string> {
      try {
        const url = await run(
          ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body],
          repoPath,
        );
        // gh prints the PR URL as the last line of stdout.
        return url.split('\n').filter(Boolean).pop() ?? url;
      } catch (err) {
        const msg = (err as GhError).message ?? '';
        if (/already exists|a pull request for branch/i.test(msg)) {
          const existing = await this.prView(opts.head);
          if (existing) return existing.url;
        }
        throw err;
      }
    },

    // View the PR for a head branch. Returns null when there is no PR (or gh is
    // unavailable/unauthenticated) — callers treat null as "nothing to reconcile".
    async prView(head: string): Promise<PrState | null> {
      try {
        const raw = await run(['pr', 'view', head, '--json', 'state,url'], repoPath);
        const parsed = JSON.parse(raw) as { state?: string; url?: string };
        if (!parsed.state || !parsed.url) return null;
        return { state: parsed.state as PrState['state'], url: parsed.url };
      } catch {
        return null;
      }
    },

    // Rich read for the follow-up loop: reviews, status-check rollup, and the
    // commit list, alongside state+url. Returns null on any failure (gh
    // unauthenticated, no PR, malformed JSON), matching prView — callers treat
    // null as "nothing to reconcile this pass".
    async prStatus(head: string): Promise<PrStatus | null> {
      try {
        const raw = await run(
          ['pr', 'view', head, '--json', 'reviews,statusCheckRollup,commits,url,state'],
          repoPath,
        );
        const parsed = JSON.parse(raw) as {
          state?: string;
          url?: string;
          reviews?: RawReview[];
          statusCheckRollup?: RawCheck[];
          commits?: RawCommit[];
        };
        if (!parsed.state || !parsed.url) return null;
        return {
          state: parsed.state as PrState['state'],
          url: parsed.url,
          reviews: (parsed.reviews ?? []).map(parseReview),
          checks: (parsed.statusCheckRollup ?? []).map(parseCheck).filter((c): c is PrCheck => c !== null),
          commits: (parsed.commits ?? []).map(parseCommit),
        };
      } catch {
        return null;
      }
    },

    // Post a top-level comment on the PR for a head branch (the drafted reply to
    // a reviewer). Only Sthapathi calls this — agents produce reply text, they
    // never write to GitHub. Never resolves review threads. Returns the comment
    // URL gh prints, or null on failure so a failed post never wedges the loop.
    async prReply(head: string, body: string): Promise<string | null> {
      try {
        const out = await run(['pr', 'comment', head, '--body', body], repoPath);
        return out.split('\n').filter(Boolean).pop() ?? null;
      } catch {
        return null;
      }
    },
  };
}