// Layer-2 session persistence (ARD §9, §9.1) — the session bead. The moment
// decomposition (Stage 3) yields a plan, the SERVER creates a dedicated `bd`
// bead of type `suthradhara-session` that is the durable spine of the session
// and its commit journal: it carries the intended plan (epic + children +
// acceptance + dep edges + the design-doc path) and, as the confirmed commit
// proceeds (xa0.6), records what has landed (epic id, each child id, deps added,
// doc sha). A crash mid-commit is recovered by RECONCILING against this journal
// on resume — create only what's missing — not by replaying blindly (Q2).
//
// Two invariants this file exists to keep:
//
//  1. QUEUE ISOLATION (§9.1). The bead must never reach Sthapathi as work.
//     `SUTHRADHARA_SESSION_TYPE` is set at CREATION so the selection filter in
//     pickup.ts (pickNext) excludes it from the first instant — the race-proof
//     half. The server then claims it (in_progress + owned by SUTHRADHARA_ACTOR)
//     so it is also out of the unclaimed `bd ready` pool — the structural half,
//     which is also runtime-accurate (Phalaka can show "session X is working").
//
//  2. SERVER-MANAGED LIFECYCLE (§9.1). Create/journal/close run HERE, on the
//     server, over the one bead id the server owns — never through the model's
//     allowlist. That is why the model's filing surface still provably excludes
//     `bd close` / `bd update --claim` (allowlist.ts): the sole-writer invariant
//     governs executable work-state, and a session bead is not that.
//
// Layout mirrors filing.ts: PURE builders + reconcile logic (unit-testable with
// no process), and a thin `SessionBeadStore` that runs the argv via
// execFile('bd', …) with no shell.

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config';
import type { Decomposition } from './decomposition';
import {
  compileFilingPlan,
  type DepStep,
  type FilingStep,
} from './filing';

const execFileAsync = promisify(execFile);

// The bd issue type marking a Suthradhara session bead. Load-bearing: pickup.ts
// filters on this exact literal, so it is the single source of truth for both
// the writer (here) and the filter. Set at creation → excluded from the first
// instant (§9.1, race-proof isolation).
export const SUTHRADHARA_SESSION_TYPE = 'suthradhara-session';

// The actor a session bead is owned by. `in_progress` + owned keeps it out of
// the unclaimed `bd ready` pool (structural isolation) and is a distinct,
// non-human owner so an operator's own claimed beads are never confused with it.
export const SUTHRADHARA_ACTOR = 'suthradhara';

// Bumped only on a non-additive change to the on-bead payload. load() rejects an
// unknown version rather than mis-hydrating a foreign shape mid-commit.
export const SESSION_BEAD_RECORD_VERSION = 1 as const;

// The immutable plan spine: the confirmed decomposition plus the design-doc path
// the same commit writes. Fixed once the bead is created — the journal is the
// only thing that grows.
export interface SessionPlan {
  decomposition: Decomposition;
  docPath: string;
  // The external source ref (pmb.7) stamped onto every filed bead via
  // `--external-ref`. Part of the immutable spine so a resume recompiles the plan
  // with the SAME ref (idempotent re-file). Absent for a repo-only interview.
  externalRef?: string;
}

// The commit journal — what has landed so far, grown monotonically as each step
// completes. `childIds` maps a proposal ref → the real bead id captured from
// `bd create --silent`; `depsAdded` holds canonical dep keys; `docSha` is set
// once the design doc is written. Absence of a field means "not yet done", which
// is exactly what reconcile() reads to decide what remains.
export interface CommitJournal {
  epicId?: string;
  childIds: Record<string, string>;
  depsAdded: string[];
  docSha?: string;
}

// The full payload persisted in the bead's `metadata`. Self-describing (version
// + plan + journal) so a resume can reconstruct the entire commit state from the
// bead alone, with no reliance on the Layer-1 transcript.
export interface SessionBeadRecord {
  version: typeof SESSION_BEAD_RECORD_VERSION;
  plan: SessionPlan;
  journal: CommitJournal;
}

export function emptyJournal(): CommitJournal {
  return { childIds: {}, depsAdded: [] };
}

export function newSessionBeadRecord(plan: SessionPlan): SessionBeadRecord {
  return { version: SESSION_BEAD_RECORD_VERSION, plan, journal: emptyJournal() };
}

// Canonical key for a dependency edge, used as the journal's dedup identity so
// the same edge is never added twice across a reconcile. `blocked<-blocker`
// matches the human `bd dep` reading (blocked depends-on blocker).
export function depKey(blockedRef: string, blockerRef: string): string {
  return `${blockedRef}<-${blockerRef}`;
}

function stepDepKey(step: DepStep): string {
  return depKey(step.blockedRef, step.blockerRef);
}

// The deterministic id a child WILL receive once the epic exists (`<epic>.N`,
// 1-based in proposal order). This is what makes reconcile's existence-checks
// exact (§7, Q2): a resume can verify a child by its predictable id rather than
// guessing. Exposed for xa0.6's executor and the tests.
export function expectedChildId(epicId: string, index: number): string {
  return `${epicId}.${index + 1}`;
}

// ── journal updates (immutable) ──────────────────────────────────────────────
// Each returns a NEW record with one item marked landed. Mirrors confirm.ts's
// fold-a-frame-into-new-state style so callers never mutate a shared record.

export function recordEpicFiled(r: SessionBeadRecord, epicId: string): SessionBeadRecord {
  return { ...r, journal: { ...r.journal, epicId } };
}

export function recordChildFiled(
  r: SessionBeadRecord,
  ref: string,
  id: string,
): SessionBeadRecord {
  return { ...r, journal: { ...r.journal, childIds: { ...r.journal.childIds, [ref]: id } } };
}

export function recordDepAdded(r: SessionBeadRecord, step: DepStep): SessionBeadRecord {
  const key = stepDepKey(step);
  if (r.journal.depsAdded.includes(key)) return r;
  return { ...r, journal: { ...r.journal, depsAdded: [...r.journal.depsAdded, key] } };
}

export function recordDocWritten(r: SessionBeadRecord, docSha: string): SessionBeadRecord {
  return { ...r, journal: { ...r.journal, docSha } };
}

// ── reconcile ────────────────────────────────────────────────────────────────

// What still needs to be committed, given the journal. This is the resume
// primitive (§7, Q2): xa0.6's executor calls it, runs the returned steps, and
// journals each as it lands. It NEVER re-emits a step the journal already
// records — so re-running after a full commit yields `{writeDoc:false, steps:[],
// complete:true}` (files nothing new), and a mid-commit crash yields exactly the
// unfinished tail (files each remaining item exactly once).
export interface ReconcilePlan {
  // The design doc has not been written yet (journal.docSha unset).
  writeDoc: boolean;
  // The create/dep steps not yet journaled, in the same canonical order
  // compileFilingPlan produces (epic → children → deps).
  steps: FilingStep[];
  // Nothing left: doc written and every step landed.
  complete: boolean;
}

export function reconcile(record: SessionBeadRecord): ReconcilePlan {
  const full = compileFilingPlan(record.plan.decomposition, record.plan.externalRef);
  const j = record.journal;
  const epicRef = record.plan.decomposition.epic.ref;

  const steps: FilingStep[] = [];
  for (const step of full.steps) {
    if (step.kind === 'create') {
      const landed =
        step.ref === epicRef ? j.epicId !== undefined : j.childIds[step.ref] !== undefined;
      if (!landed) steps.push(step);
    } else {
      if (!j.depsAdded.includes(stepDepKey(step))) steps.push(step);
    }
  }

  const writeDoc = j.docSha === undefined;
  return { writeDoc, steps, complete: !writeDoc && steps.length === 0 };
}

// ── serialization ────────────────────────────────────────────────────────────

export function serializeRecord(r: SessionBeadRecord): string {
  return JSON.stringify(r);
}

export class SessionBeadParseError extends Error {
  constructor(detail: string) {
    super(`Cannot read suthradhara-session bead payload: ${detail}`);
    this.name = 'SessionBeadParseError';
  }
}

// Reconstruct a record from a bead's `metadata`, which `bd show --json` may
// return already parsed (object) or as a JSON string depending on version.
// Narrow structural validation only — the server is the sole writer, so this
// just guards against a foreign/corrupt payload before a resume trusts it.
export function parseRecord(metadata: unknown): SessionBeadRecord {
  let obj: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      obj = JSON.parse(metadata);
    } catch (err) {
      throw new SessionBeadParseError(`invalid JSON: ${(err as Error).message}`);
    }
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new SessionBeadParseError('payload is not an object');
  }
  const v = obj as Partial<SessionBeadRecord>;
  if (v.version !== SESSION_BEAD_RECORD_VERSION) {
    throw new SessionBeadParseError(`unsupported record version: ${String(v.version)}`);
  }
  if (typeof v.plan !== 'object' || v.plan === null) {
    throw new SessionBeadParseError('missing plan');
  }
  if (typeof v.journal !== 'object' || v.journal === null) {
    throw new SessionBeadParseError('missing journal');
  }
  return obj as SessionBeadRecord;
}

// The bead title — human-visible in `bd list`/Phalaka. Prefixed so a session
// bead is unmistakable at a glance and never read as a deliverable.
export function sessionBeadTitle(plan: SessionPlan): string {
  return `Suthradhara session: ${plan.decomposition.epic.title}`;
}

// The `bd create` argv for a session bead. TYPE and OWNER are set here, at
// creation — the type so the pickup filter excludes it immediately, the assignee
// so ownership is correct even in the window before the follow-up claim lands.
// The whole record (plan + empty journal) rides in `--metadata` so the spine is
// durable from the first write. `--silent` prints only the id for capture. Pure:
// every value is its own argv element (no shell), so an operator-supplied title
// is inert data.
export function buildCreateSessionBeadArgv(record: SessionBeadRecord): string[] {
  return [
    'create',
    sessionBeadTitle(record.plan),
    '-t', SUTHRADHARA_SESSION_TYPE,
    '-p', '2',
    '--assignee', SUTHRADHARA_ACTOR,
    '--metadata', serializeRecord(record),
    '--silent',
  ];
}

// ── server-managed lifecycle ─────────────────────────────────────────────────

export class SessionBeadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SessionBeadError';
  }
}

// The server's handle to the ONE session bead it owns for a session. All four
// verbs (create/claim/journal/close) run here via execFile — never through the
// model — which is what keeps the model allowlist free of close/claim (§9.1).
export class SessionBeadStore {
  constructor(private readonly kshetra: KshetraConfig) {}

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, BEADS_DIR: this.kshetra.beads.path };
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('bd', args, {
        env: this.env(),
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new SessionBeadError(
        `bd ${args[0]} failed: ${e.stderr ?? e.message ?? String(err)}`,
        err,
      );
    }
  }

  // Create the session bead the moment a plan exists, then immediately claim it.
  // The type is set by the create, so the sub-second window before the claim is
  // already excluded from `bd ready` by the pickup filter (§9.1) — no poll race.
  // Returns the new id and the persisted record.
  async create(plan: SessionPlan): Promise<{ id: string; record: SessionBeadRecord }> {
    const record = newSessionBeadRecord(plan);
    const id = await this.exec(buildCreateSessionBeadArgv(record));
    if (id === '') {
      throw new SessionBeadError('bd create returned no id for the session bead');
    }
    await this.exec(['update', id, '--status', 'in_progress', '--assignee', SUTHRADHARA_ACTOR]);
    return { id, record };
  }

  // Persist an updated journal after a commit step lands. Overwrites the whole
  // metadata payload (plan is immutable, journal has grown) so the bead always
  // reflects the latest committed state — the source of truth reconcile reads.
  async journal(id: string, record: SessionBeadRecord): Promise<void> {
    await this.exec(['update', id, '--metadata', serializeRecord(record)]);
  }

  // Reconstruct the record from the bead for a resume. Returns null if the bead
  // carries no payload (nothing to reconcile against).
  async load(id: string): Promise<SessionBeadRecord | null> {
    const raw = await this.exec(['show', id, '--json']);
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new SessionBeadError(`bd show returned invalid JSON: ${(err as Error).message}`);
    }
    const meta = (doc as { metadata?: unknown }).metadata;
    if (meta === undefined || meta === null || meta === '') return null;
    return parseRecord(meta);
  }

  // Close the session bead when the session completes. Server-driven — the model
  // never holds `bd close`.
  async close(id: string, reason: string): Promise<void> {
    await this.exec(['close', id, '--reason', reason]);
  }
}
