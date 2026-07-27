// The second, novel write surface (ARD §6.2, §8) — the per-feature design doc.
// This is the first place in the whole system with a file-write grant, so it is
// the most careful module in Suthradhara. Two controls make it safe:
//
//   1. Server-authors-the-file (Q4). There is NO native `Write` tool in any
//      allowlist (see allowlist.ts — READ_ONLY_TOOLS / FILING_BASH_PATTERNS name
//      no Write/Edit). The model emits the doc CONTENT over the socket; the
//      SERVER writes it to a vetted path. The model never holds the pen, so a
//      path escape is impossible to express from inside the interview — the only
//      writer is writeDesignDoc() below, and it guards every call.
//
//   2. Path-scope, not a blanket write (§6.2 "the doc-write path guard is as
//      load-bearing as the bd allowlist"). Every write is confined to the
//      Kshetra's design-docs dir; a target that resolves anywhere else — a source
//      file, config, a `../` escape, an absolute path — is refused by
//      assertWithinDesignDir() before a byte is written. Getting this wrong turns
//      a design agent into an arbitrary file writer, so the guard has a mandatory
//      negative test (§6.2, §15): writing `src/index.ts` must be denied.
//
// No git (§6.2). Writing the file is the whole action; the doc lands in the
// working tree and a human (or a later flow) commits it. Nothing here runs
// `git add/commit/push`.
//
// Delivery is by on-demand read (§8): linkDocIntoDecomposition() stamps the doc
// path into the epic and every child description, so Silpi/Viharapala `Read` the
// full design exactly where it is relevant — never force-injected into unrelated
// tasks. A cross-cutting decision worth surfacing beyond the doc becomes a
// provider-neutral `bd remember` fact (buildRememberFactArgv), NOT an edit to
// conventions.architecture and NOT provider-native Memory (§8.2, NG8).
//
// This module owns the write PRIMITIVE, the guard, the linkage, and the remember
// builder. Sequencing them behind the confirm gate (write doc first, then file
// beads, journaling each step, with partial-failure recovery) is xa0.6.

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, relative, dirname, isAbsolute } from 'path';
import type { KshetraConfig } from '../kshetra/config';
import type { Decomposition } from './decomposition';

// Default design-docs dir, relative to the repo root (Q3 — proposed
// `<repo>/.shreni/design/`). Deliberately a distinct subtree from `.shreni/`
// runtime state and from source; the guard confines writes to exactly here.
// Kept a constant (not a config field) for xa0.5 — §8.2 warns against a
// `conventions.design` field, and a per-repo dir override can be layered on
// later without touching the guard.
export const DEFAULT_DESIGN_DIR = '.shreni/design';

// The absolute design-docs dir for a Kshetra. Reads repo.path (already absolute
// per the one-config-per-Kshetra rule) and joins the default subtree.
export function resolveDesignDir(kshetra: KshetraConfig): string {
  return resolve(kshetra.repo.path, DEFAULT_DESIGN_DIR);
}

// A repo-relative + absolute pair for a doc that has been (or will be) written.
// `relPath` is what goes verbatim into bead descriptions for on-demand read —
// executors `Read` it relative to the repo root (their cwd), so it must stay
// repo-relative, never absolute or host-specific.
export interface DesignDocRef {
  relPath: string;
  absPath: string;
}

// A write target that resolved outside the design-docs dir. Thrown BEFORE any
// filesystem call, so a rejected path never creates a directory or a file.
export class DesignDocPathError extends Error {
  constructor(
    public readonly attempted: string,
    public readonly designDir: string,
  ) {
    super(
      `Refusing design-doc write to "${attempted}": it is outside the design-docs ` +
        `directory "${designDir}". Suthradhara may only write per-feature design ` +
        `docs under ${DEFAULT_DESIGN_DIR}/.`,
    );
    this.name = 'DesignDocPathError';
  }
}

// The load-bearing guard. Given the design dir and a candidate ABSOLUTE target,
// return it normalised if it is a file strictly inside the dir, else throw.
// Purely lexical (resolve-based): it does not follow symlinks — a hardened
// realpath check is a future tightening, noted so it is a deliberate scope line,
// not an oversight. `relative()` yields '' for the dir itself (not a file →
// reject), a leading '..' for any escape, and an absolute path across drives
// (Windows) — all rejected.
export function assertWithinDesignDir(designDir: string, candidateAbs: string): string {
  const abs = resolve(candidateAbs);
  const dir = resolve(designDir);
  const rel = relative(dir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new DesignDocPathError(candidateAbs, dir);
  }
  return abs;
}

// Resolve a repo-relative write target and guard it in one step. `repoRelPath`
// is what the server intends to write (e.g. `.shreni/design/sso-login.md`, or —
// in the negative test — `src/index.ts`, which resolves outside the design dir
// and is refused). Returns the normalised ref; throws DesignDocPathError on an
// out-of-dir path.
export function resolveDocWrite(kshetra: KshetraConfig, repoRelPath: string): DesignDocRef {
  const abs = resolve(kshetra.repo.path, repoRelPath);
  assertWithinDesignDir(resolveDesignDir(kshetra), abs);
  // Re-derive relPath from the resolved abs so the stored/link value is
  // normalised (no `./`, no redundant segments) regardless of how it came in.
  const relPath = relative(kshetra.repo.path, abs);
  return { relPath, absPath: abs };
}

// Turn a feature name into a filesystem- and link-safe slug: lowercase, ASCII
// alphanumerics, single hyphens between words, no leading/trailing hyphen.
// Length-capped so a rambling feature name can't produce an unwieldy filename.
export function slugifyFeature(feature: string): string {
  const slug = feature
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug;
}

// The default repo-relative path for a feature's doc: `<design dir>/<slug>.md`.
// The server derives the filename from the feature name rather than letting the
// model choose a path — a second layer of scoping on top of the guard (a
// model-chosen path can't smuggle in a traversal because it never chooses one).
export function designDocRelPath(feature: string): string {
  const slug = slugifyFeature(feature);
  if (slug === '') {
    throw new Error(`Cannot derive a design-doc filename from feature name "${feature}".`);
  }
  return `${DEFAULT_DESIGN_DIR}/${slug}.md`;
}

export interface WriteDesignDocOpts {
  kshetra: KshetraConfig;
  // Repo-relative target. Use designDocRelPath(feature) for the derived default;
  // an explicit value is still guarded, so an out-of-dir path is always refused.
  relPath: string;
  // The full doc body the model emitted — as deep as the interview warranted
  // (§8). Rejected if blank: a stub is exactly what Suthradhara exists not to
  // produce.
  content: string;
}

// Server-authors-the-file: write the model-emitted doc content to a guarded path
// under the design dir. Guards FIRST (an out-of-dir path throws before any mkdir
// or write), then creates the containing dir and writes the file. Ensures a
// single trailing newline for clean diffs on the in-place updates xa0.8 makes.
// No git. Returns the ref the caller stamps into beads via linkDocIntoDecomposition.
export function writeDesignDoc(opts: WriteDesignDocOpts): DesignDocRef {
  if (opts.content.trim() === '') {
    throw new Error('Refusing to write an empty design doc.');
  }
  const ref = resolveDocWrite(opts.kshetra, opts.relPath);
  mkdirSync(dirname(ref.absPath), { recursive: true });
  const body = opts.content.endsWith('\n') ? opts.content : `${opts.content}\n`;
  writeFileSync(ref.absPath, body, 'utf8');
  return ref;
}

// The on-demand-read link line stamped into a bead description. A stable prefix
// so it can be found and replaced idempotently — re-presenting a proposal, or an
// xa0.8 in-place update, never accumulates duplicate link lines. Exported so the
// evolve locator (xa0.8) can run the inverse — recover a doc path from a bead
// that links it, turning "linked-from beads" into a locate signal (§8.1 step 1).
export const DOC_LINK_PREFIX = 'Design doc (read before implementing): ';

// The inverse of withDocLink: pull the linked doc path back out of a bead
// description, or null if it carries no link line. Used by the evolve locator to
// find the doc a related bead already points at (§8.1). Tolerant of surrounding
// whitespace; returns the FIRST link line's path (withDocLink keeps exactly one).
export function parseDocLink(description: string | undefined): string | null {
  for (const line of (description ?? '').split('\n')) {
    if (line.startsWith(DOC_LINK_PREFIX)) {
      const path = line.slice(DOC_LINK_PREFIX.length).trim();
      return path === '' ? null : path;
    }
  }
  return null;
}

// Append (or refresh) the doc-path link on a description. Strips any prior link
// line first — even one pointing at a different path — so the description always
// carries exactly one current link. Idempotent: linking the same doc twice is a
// no-op in content.
export function withDocLink(description: string | undefined, docRelPath: string): string {
  const link = DOC_LINK_PREFIX + docRelPath;
  const base = (description ?? '')
    .split('\n')
    .filter((line) => !line.startsWith(DOC_LINK_PREFIX))
    .join('\n')
    .trimEnd();
  return base === '' ? link : `${base}\n\n${link}`;
}

// Stamp the doc path into the epic and every child description so each filed
// bead links the design doc for on-demand read (§8). Pure — returns a new
// Decomposition; acceptance criteria and deps are untouched (the link is
// rationale, not a definition of done). filing.ts then embeds these descriptions
// in the `bd create -d` argv, so the link ships with the bead.
export function linkDocIntoDecomposition(d: Decomposition, docRelPath: string): Decomposition {
  return {
    epic: { ...d.epic, description: withDocLink(d.epic.description, docRelPath) },
    children: d.children.map((c) => ({
      ...c,
      description: withDocLink(c.description, docRelPath),
    })),
    deps: d.deps,
  };
}

export interface RememberFactOpts {
  // The feature the fact is about, for a searchable lead-in.
  feature: string;
  // The repo-relative doc path the fact points at.
  docRelPath: string;
  // Optional one-line summary of the cross-cutting decision worth surfacing
  // beyond the doc; omitted for a bare pointer.
  summary?: string;
}

// Build the argv for the optional durable pointer (§8, §8.2): a provider-neutral
// `bd remember` fact pointing at the doc. Returns an argv ARRAY (never a shell
// string), mirroring filing.ts's argument-hygiene guarantee — xa0.6's executor
// runs execFile('bd', argv) with no shell, so operator-supplied text is inert.
// This is the ONLY durable-pointer channel: NOT an edit to conventions.architecture
// (human-owned) and NOT provider-native Memory (per-provider, fragments on switch).
// `bd remember` is unreachable to the model (absent from every allowlist); only
// the server may run it, which is the point.
export function buildRememberFactArgv(opts: RememberFactOpts): string[] {
  const summary = opts.summary?.trim();
  const fact = summary
    ? `${opts.feature}: ${summary} See ${opts.docRelPath}.`
    : `${opts.feature} design recorded. See ${opts.docRelPath}.`;
  return ['remember', fact];
}
