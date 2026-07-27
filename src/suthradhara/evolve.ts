// Evolve an existing feature's design doc IN PLACE (ARD §8.1, G9, bead xa0.8) —
// the machinery that keeps "one source of truth per feature" true when the
// operator returns to extend or change a feature rather than start a new one.
// Without this, a second design pass would slugify the feature name afresh and
// write a PARALLEL doc, stranding the first as stale — exactly the fragmentation
// §8.1 forbids and the on-demand-read guarantee (§8) depends on avoiding.
//
// Four steps, mirrored by the ARD:
//   1. LOCATE (locateExistingDocs) — before Stage 3/4, search the design-docs
//      dir AND the linked-from beads for the doc(s) covering the named feature.
//      Filesystem grounding (name/content match over the docs dir) plus a
//      `bd search` whose hits carry a `Design doc: <path>` link back to a doc.
//   2. CLASSIFY (classifyMatches) — none → create fresh (the §8 default); one →
//      evolve it; many → ASK the operator which (renderCandidateChoice), never
//      guess. Ambiguity is the operator's to resolve (§8.1).
//   3. RECONCILE — the located doc's content rides into the prompt (prompt.ts)
//      so clarification is framed against the existing design; and the commit
//      proposal renders the change as a DIFF (renderDocDiff) against that content.
//   4. UPDATE IN PLACE — evolveDocTarget() returns the EXISTING doc's relPath so
//      writeDesignDoc (server-authors, path-guarded — unchanged from §6.2)
//      rewrites the SAME file; linkDocIntoDecomposition then re-stamps that one
//      path into the new/changed beads, keeping one doc and one bead lineage.
//
// This module is pure over injected deps (a doc lister + a bd search), so the
// whole locate → classify → fold pipeline is unit-testable without a filesystem
// or a database. The turn loop (turnloop.ts) supplies the real deps.

import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config';
import type { EvolveState } from './state';
import { resolveDesignDir, designDocRelPath, parseDocLink, slugifyFeature } from './designdoc';

const execFileAsync = promisify(execFile);

// A design doc as the locator sees it: repo-relative path + its current body.
export interface DocFile {
  relPath: string;
  content: string;
}

// A bead hit from `bd search`, narrowed to what the locator needs to recover the
// doc a related bead links (its description carries the `Design doc: <path>` line).
export interface BeadHit {
  id: string;
  title: string;
  description?: string;
}

// How a doc came to be a candidate — surfaced so the operator's disambiguation
// prompt can say WHY each doc matched, and so a bead-linked match (a strong
// signal: a real bead already points here) can outrank a loose name match.
export type MatchKind = 'name' | 'content' | 'bead';

// A located doc, with the evidence for the match and the beads that link it.
export interface LocatedDoc {
  relPath: string;
  content: string;
  matchedVia: MatchKind[];
  // Ids of beads whose descriptions link this doc (the §8.1 "linked-from beads"
  // signal). Empty when the match came only from the filesystem.
  linkedBeadIds: string[];
  // Higher = a more confident match; used to sort candidates and to decide when
  // a lone weak match is worth surfacing at all.
  score: number;
}

// The injectable read surface for locate. Both default to the real filesystem /
// `bd` (defaultLocateDeps); tests pass fakes. `bdSearch` may reject — the caller
// treats a search failure as "no bead signal", never fatal.
export interface LocateDeps {
  listDocs: () => DocFile[];
  bdSearch: (query: string) => Promise<BeadHit[]>;
}

// The injectable read surface for a SOURCE locate (pmb.7): recover the design
// doc(s) a prior consult of an external ticket already produced, by the beads it
// filed carrying that ticket's external ref. Kept separate from LocateDeps (which
// searches by feature name/content) so existing feature-locate callers are
// unaffected. `bdSearchByExternalRef` may reject — the caller treats a search
// failure as "no prior consult", never fatal.
export interface SourceLocateDeps {
  listDocs: () => DocFile[];
  bdSearchByExternalRef: (ref: string) => Promise<BeadHit[]>;
}

// Split a feature name into lowercase alphanumeric tokens for overlap scoring.
// Drops very short/stop-ish tokens so "the"/"for"/"a" don't create spurious
// matches between unrelated features.
const STOP_TOKENS = new Set(['the', 'for', 'and', 'a', 'an', 'to', 'of', 'in', 'on', 'with']);

export function featureTokens(feature: string): string[] {
  return slugifyFeature(feature)
    .split('-')
    .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
}

// Score how well a doc matches the feature, and by what evidence. Name match
// (feature tokens present in the filename slug) is the primary signal; content
// match (tokens present in the doc body, esp. its first heading) is secondary.
// Bead-link evidence is added by the caller (it comes from `bd search`, not the
// file). A doc with zero token overlap and no bead link scores 0 and is dropped.
function scoreDocAgainstFeature(
  doc: DocFile,
  tokens: string[],
): { score: number; matchedVia: MatchKind[] } {
  if (tokens.length === 0) return { score: 0, matchedVia: [] };
  const matchedVia: MatchKind[] = [];

  // Filename slug (e.g. `.shreni/design/sso-login.md` → "sso-login").
  const nameSlug = doc.relPath.replace(/^.*\//, '').replace(/\.md$/i, '').toLowerCase();
  const nameTokens = new Set(nameSlug.split('-').filter(Boolean));
  const nameHits = tokens.filter((t) => nameTokens.has(t)).length;

  const body = doc.content.toLowerCase();
  const contentHits = tokens.filter((t) => body.includes(t)).length;

  let score = 0;
  if (nameHits > 0) {
    matchedVia.push('name');
    // Fraction of the feature's tokens present in the filename, weighted high —
    // a filename is a deliberate label, so overlap there is a strong signal.
    score += (nameHits / tokens.length) * 10;
  }
  if (contentHits > 0) {
    matchedVia.push('content');
    score += (contentHits / tokens.length) * 3;
  }
  return { score, matchedVia };
}

// The floor a filesystem-only match must clear to be surfaced. A single loose
// token overlap ("api" appearing in an unrelated doc) stays below it; a bead-
// linked match bypasses the floor entirely (a real bead pointing here is
// authoritative regardless of name similarity).
const MIN_FS_SCORE = 3;

// LOCATE (§8.1 step 1). Find the design doc(s) covering `feature` by two
// independent signals merged on doc path:
//   • filesystem — every doc in the design dir, scored by name/content overlap;
//   • beads — `bd search <feature>` hits whose descriptions link a doc path.
// Returns matches sorted strongest-first. A `bd search` failure degrades to the
// filesystem signal alone (never throws). Deterministic and pure over deps.
export async function locateExistingDocs(
  feature: string,
  deps: LocateDeps,
): Promise<LocatedDoc[]> {
  const tokens = featureTokens(feature);
  const docs = deps.listDocs();
  const byPath = new Map<string, LocatedDoc>();

  // Filesystem signal.
  for (const doc of docs) {
    const { score, matchedVia } = scoreDocAgainstFeature(doc, tokens);
    if (score >= MIN_FS_SCORE) {
      byPath.set(doc.relPath, {
        relPath: doc.relPath,
        content: doc.content,
        matchedVia,
        linkedBeadIds: [],
        score,
      });
    }
  }

  // Bead-link signal: a related bead's description points at a doc path.
  let hits: BeadHit[] = [];
  try {
    hits = await deps.bdSearch(feature);
  } catch {
    hits = [];
  }
  const contentByPath = new Map(docs.map((d) => [d.relPath, d.content]));
  for (const hit of hits) {
    const linked = parseDocLink(hit.description);
    if (!linked) continue;
    const existing = byPath.get(linked);
    if (existing) {
      if (!existing.matchedVia.includes('bead')) existing.matchedVia.push('bead');
      existing.linkedBeadIds.push(hit.id);
      existing.score += 6; // a real bead pointing here is a strong confirmation
    } else {
      // A doc a bead links but the filesystem scorer missed (name/content didn't
      // overlap). Still a genuine match — include it, reading its body if present.
      const content = contentByPath.get(linked);
      if (content !== undefined) {
        byPath.set(linked, {
          relPath: linked,
          content,
          matchedVia: ['bead'],
          linkedBeadIds: [hit.id],
          score: 6,
        });
      }
    }
  }

  return [...byPath.values()].sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath),
  );
}

// LOCATE BY SOURCE (pmb.7, §3). Find the design doc(s) a PRIOR consult of an
// external ticket already produced, by the beads it filed carrying that ticket's
// external ref: `bd search --external-contains <ref>` hits whose descriptions link
// a doc path (the same bead-link signal as §8.1, keyed on the external ref instead
// of a feature name). This is what makes consulting the SAME ticket twice route to
// evolve-in-place rather than fork a duplicate epic. A search failure degrades to
// no matches (never throws). Returns matches sorted strongest-first. Pure over deps.
export async function locateDocsBySource(
  ref: string,
  deps: SourceLocateDeps,
): Promise<LocatedDoc[]> {
  let hits: BeadHit[] = [];
  try {
    hits = await deps.bdSearchByExternalRef(ref);
  } catch {
    hits = [];
  }
  const contentByPath = new Map(deps.listDocs().map((d) => [d.relPath, d.content]));
  const byPath = new Map<string, LocatedDoc>();
  for (const hit of hits) {
    const linked = parseDocLink(hit.description);
    if (!linked) continue;
    const content = contentByPath.get(linked);
    if (content === undefined) continue; // bead links a doc no longer on disk
    const existing = byPath.get(linked);
    if (existing) {
      existing.linkedBeadIds.push(hit.id);
      existing.score += 6; // each bead pointing here strengthens the match
    } else {
      byPath.set(linked, {
        relPath: linked,
        content,
        matchedVia: ['bead'],
        linkedBeadIds: [hit.id],
        score: 6,
      });
    }
  }
  return [...byPath.values()].sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath),
  );
}

// CLASSIFY (§8.1 step 2). Turn the ranked matches into the three outcomes that
// drive the interview: none (create fresh — the §8 default), one (evolve it),
// many (ask which). "Many" only when a genuinely ambiguous set exists — a clearly
// dominant top match (its score well ahead of the runner-up) collapses to `one`
// so a strong bead-linked hit isn't drowned by loose name matches.
export type LocateOutcome =
  | { kind: 'none' }
  | { kind: 'one'; doc: LocatedDoc }
  | { kind: 'many'; docs: LocatedDoc[] };

// The runner-up must be at least this fraction of the leader's score to count as
// a real rival; below it, the leader is treated as the unambiguous match.
const DOMINANCE_RATIO = 0.5;

export function classifyMatches(matches: LocatedDoc[]): LocateOutcome {
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', doc: matches[0] };
  const [top, next] = matches;
  if (next.score < top.score * DOMINANCE_RATIO) return { kind: 'one', doc: top };
  return { kind: 'many', docs: matches };
}

// Render the "which doc do you want to evolve?" prompt when >1 plausibly matched.
// Numbered so the operator can reply with an index; each line names the path and
// why it matched, so the choice is informed. Never auto-picks — the ARD is
// explicit that silently updating the wrong doc is a failure.
export function renderCandidateChoice(docs: LocatedDoc[]): string {
  const lines = docs.map((d, i) => {
    const via = d.matchedVia.join(', ');
    const beads = d.linkedBeadIds.length ? ` — linked from ${d.linkedBeadIds.join(', ')}` : '';
    return `  ${i + 1}. ${d.relPath} (matched via ${via}${beads})`;
  });
  return [
    'More than one existing design doc could cover this feature. Which one should I evolve in place?',
    ...lines,
    `  ${docs.length + 1}. None of these — create a new doc instead.`,
    'Reply with the number (or the path).',
  ].join('\n');
}

// Resolve the operator's disambiguation reply against pending `candidates`.
// Accepts a 1-based index (including the final "none of these" option → null =
// create fresh) or a path substring. Returns:
//   • { chosen: '<relPath>' } — evolve that doc;
//   • { chosen: null }        — the "none" option: create a new doc;
//   • { chosen: undefined }   — the reply didn't map to any option (ask again).
export function resolveCandidateChoice(
  candidates: string[],
  reply: string,
): { chosen: string | null | undefined } {
  const t = reply.trim();
  const asIndex = Number(t);
  if (Number.isInteger(asIndex) && asIndex >= 1) {
    if (asIndex <= candidates.length) return { chosen: candidates[asIndex - 1] };
    if (asIndex === candidates.length + 1) return { chosen: null }; // "none — create new"
    return { chosen: undefined };
  }
  const lower = t.toLowerCase();
  const byPath = candidates.filter((c) => c.toLowerCase().includes(lower));
  if (t.length >= 3 && byPath.length === 1) return { chosen: byPath[0] };
  if (/\bnone\b|\bnew\b|\bcreate\b/i.test(t)) return { chosen: null };
  return { chosen: undefined };
}

// Fold a locate outcome into the session's evolve context (§8.1). `one` sets the
// target + content snapshot to evolve in place; `many` parks the candidates for
// the operator to choose; `none` leaves the interview a plain new-feature pass
// (no evolve context). Pure — returns a fresh EvolveState or null.
export function evolveStateFromOutcome(
  feature: string,
  outcome: LocateOutcome,
  now: string,
): EvolveState | null {
  switch (outcome.kind) {
    case 'none':
      return null;
    case 'one':
      return {
        feature,
        targetRelPath: outcome.doc.relPath,
        targetContent: outcome.doc.content,
        locatedAt: now,
      };
    case 'many':
      return { feature, candidates: outcome.docs.map((d) => d.relPath), locatedAt: now };
  }
}

// UPDATE IN PLACE (§8.1 step 3/4). The doc path the commit must write to: the
// EXISTING doc when evolving (so the same file is rewritten — no fork), else the
// default derived from the feature name (a fresh doc, the §8 default). This one
// function is what makes a second design pass update the original instead of
// creating a duplicate.
export function evolveDocTarget(
  feature: string,
  evolving: EvolveState | null | undefined,
): string {
  if (evolving?.targetRelPath) return evolving.targetRelPath;
  return designDocRelPath(feature);
}

// A single line of a rendered diff. `tag` is a unified-diff marker: ' ' context,
// '-' removed, '+' added.
export interface DiffLine {
  tag: ' ' | '-' | '+';
  text: string;
}

// Render a line-level diff of the doc change for the commit proposal (§8.1 step
// 3 — "shown as a diff"). A compact LCS over lines keeps unchanged lines as
// context and marks removals/additions, so the operator sees exactly what the
// evolve changes before confirming. Not a git diff (no hunks/line numbers) — a
// readable review aid in the proposal text. Pure and deterministic.
export function diffDocLines(oldContent: string, newContent: string): DiffLine[] {
  // Truly-empty content is zero lines, not one blank line — so a brand-new doc
  // diffs as all-additions with no spurious leading `-` removal.
  const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ tag: '-', text: a[i] });
      i++;
    } else {
      out.push({ tag: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ tag: '-', text: a[i++] });
  while (j < m) out.push({ tag: '+', text: b[j++] });
  return out;
}

// Render the diff as text for the proposal. When `oldContent` is empty (a brand-
// new doc) it degrades to an all-`+` block. Elides long runs of unchanged
// context so a small change to a large doc stays readable.
export function renderDocDiff(oldContent: string, newContent: string, relPath: string): string {
  const lines = diffDocLines(oldContent, newContent);
  const header = oldContent.trim() === ''
    ? `New design doc: ${relPath}`
    : `Design doc changes (${relPath}):`;
  const rendered = collapseContext(lines).map((l) => `${l.tag} ${l.text}`);
  return [header, '```diff', ...rendered, '```'].join('\n');
}

// Keep up to CONTEXT unchanged lines around each change; replace longer runs with
// a `@@ … @@` elision so the diff shows what changed, not the whole file.
const CONTEXT = 3;

function collapseContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].tag !== ' ') {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) {
        keep[k] = true;
      }
    }
  }
  const out: DiffLine[] = [];
  let elided = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]);
      elided = false;
    } else if (!elided) {
      out.push({ tag: ' ', text: '@@ … @@' });
      elided = true;
    }
  }
  return out;
}

// Bind the locator to a Kshetra for use as the turn loop's `locate` dependency:
// a `(feature) => Promise<LocatedDoc[]>` over the real filesystem + `bd`.
export function makeLocateFn(kshetra: KshetraConfig): (feature: string) => Promise<LocatedDoc[]> {
  const deps = defaultLocateDeps(kshetra);
  return (feature) => locateExistingDocs(feature, deps);
}

// Bind the SOURCE locator to a Kshetra for the turn loop's `locateBySource` dep
// (pmb.7): a `(ref) => Promise<LocatedDoc[]>` that finds the doc(s) a prior consult
// of the external ticket produced, via the beads it filed carrying its external ref.
export function makeSourceLocateFn(
  kshetra: KshetraConfig,
): (ref: string) => Promise<LocatedDoc[]> {
  const deps = defaultSourceLocateDeps(kshetra);
  return (ref) => locateDocsBySource(ref, deps);
}

// Real read deps for the source locate: the same doc lister as feature-locate,
// plus a `bd search <ref> --external-contains <ref>` scoped to the Kshetra's beads
// dir. `--external-contains` filters by external-ref substring, so the beads a
// prior commit stamped with `--external-ref <ref>` are found; parseDocLink then
// recovers the design doc they link.
export function defaultSourceLocateDeps(kshetra: KshetraConfig): SourceLocateDeps {
  const designDir = resolveDesignDir(kshetra);
  return {
    listDocs: () => listMarkdownDocs(kshetra.repo.path, designDir),
    bdSearchByExternalRef: async (ref) => {
      const { stdout } = await execFileAsync(
        'bd',
        ['search', ref, '--json', '--external-contains', ref, '--status', 'all'],
        { env: { ...process.env, BEADS_DIR: kshetra.beads.path }, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim() || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
        .map((x) => ({
          id: String(x.id ?? ''),
          title: String(x.title ?? ''),
          description: typeof x.description === 'string' ? x.description : undefined,
        }))
        .filter((h) => h.id !== '');
    },
  };
}

// Real read deps: list every `*.md` under the Kshetra's design dir, and run
// `bd search --json --desc-contains <feature>` scoped to the Kshetra's beads dir.
// The search casts a wide net (title OR description containing the feature) so a
// bead that merely links the doc is found; parseDocLink then recovers the path.
export function defaultLocateDeps(kshetra: KshetraConfig): LocateDeps {
  const designDir = resolveDesignDir(kshetra);
  return {
    listDocs: () => listMarkdownDocs(kshetra.repo.path, designDir),
    bdSearch: async (query) => {
      const { stdout } = await execFileAsync(
        'bd',
        ['search', query, '--json', '--desc-contains', query, '--status', 'all'],
        { env: { ...process.env, BEADS_DIR: kshetra.beads.path }, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim() || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
        .map((x) => ({
          id: String(x.id ?? ''),
          title: String(x.title ?? ''),
          description: typeof x.description === 'string' ? x.description : undefined,
        }))
        .filter((h) => h.id !== '');
    },
  };
}

// Recursively collect `*.md` files under `designDir`, returned repo-relative with
// their content. Missing dir → empty list (a Kshetra with no docs yet). Never
// throws on an unreadable entry — a single bad file is skipped, not fatal.
function listMarkdownDocs(repoRoot: string, designDir: string): DocFile[] {
  const out: DocFile[] = [];
  const walk = (dir: string): void => {
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist / unreadable
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        try {
          out.push({ relPath: relative(repoRoot, abs), content: readFileSync(abs, 'utf8') });
        } catch {
          // skip a file we can't read
        }
      }
    }
  };
  walk(designDir);
  return out;
}
