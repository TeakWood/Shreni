// The post-confirm commit — the server-side transaction a single confirm frame
// authorises (ARD §7). The turn loop (turnloop.ts) routes a confirmed proposal
// here; NOTHING in this module runs before applyConfirmFrame has returned
// `confirmed`. It ties together the pieces already built by earlier beads:
//
//   • the session bead (xa0.9, sessionbead.ts) — created up front as the durable
//     spine + commit journal, then journaled as each item lands;
//   • the filing plan (xa0.4, filing.ts) — compiled `bd` argv for epic → children
//     → dep edges, run here with real ids captured from `bd create --silent`;
//   • reconcile (xa0.9) — so a re-run after a crash files only what is missing
//     (idempotent by reconcile, not replay — Q2).
//
// SCOPE LINE: this is the executor the turn loop calls THROUGH a seam (CommitFn).
// The design-doc write (xa0.5) and the exhaustive partial-failure / resume-
// reconcile hardening are xa0.6's to complete; here the doc is optional and the
// report is the straightforward "what landed / where it stopped". Everything runs
// via execFile('bd', argv) with NO shell — the argument-hygiene guarantee
// filing.ts documents carries through unchanged.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import type { KshetraConfig } from '../kshetra/config';
import type { Decomposition } from './decomposition';
import { resolveStepArgv, type FilingPlan } from './filing';
import { writeDesignDoc, designDocRelPath, linkDocIntoDecomposition } from './designdoc';
import { compileFilingPlan } from './filing';
import {
  SessionBeadStore,
  newSessionBeadRecord,
  recordEpicFiled,
  recordChildFiled,
  recordDepAdded,
  recordDocWritten,
  reconcile,
  type SessionPlan,
  type SessionBeadRecord,
} from './sessionbead';

const execFileAsync = promisify(execFile);

// A design doc to write as part of the commit. Optional: absent when the
// interview produced a decomposition but no doc body yet (the doc write is
// sequenced fully by xa0.6). When present, the server authors the file (§6.2)
// and stamps its path into every bead description for on-demand read (§8).
export interface CommitDoc {
  // Repo-relative target; defaults to designDocRelPath(epic.title) when omitted.
  relPath?: string;
  content: string;
}

export interface CommitInput {
  kshetra: KshetraConfig;
  // The decomposition just confirmed (grab it from state.pending BEFORE
  // applyConfirmFrame clears it). Needed for the session-bead spine and, when a
  // doc is written, for stamping the doc link into descriptions.
  decomposition: Decomposition;
  doc?: CommitDoc;
}

// What did (and didn't) land, straight from the journal. `ok` is true only when
// every step in the plan committed. On a partial failure `errors` names where it
// stopped and the id maps show exactly what was written — the operator can
// re-confirm to resume, and reconcile files only the remainder.
export interface CommitReport {
  ok: boolean;
  sessionBeadId?: string;
  epicId?: string;
  childIds: Record<string, string>;
  depsAdded: string[];
  docRelPath?: string;
  errors: string[];
}

// A `bd` runner seam so this module is unit-testable without a real database.
// The default shells out via execFile (no shell) scoped to the Kshetra's beads
// dir — identical env handling to SessionBeadStore.
export type BdRunner = (args: string[]) => Promise<string>;

export interface CommitDeps {
  bd?: BdRunner;
  // Injectable session-bead handle; defaults to the real SessionBeadStore.
  sessionBead?: {
    create(plan: SessionPlan): Promise<{ id: string; record: SessionBeadRecord }>;
    journal(id: string, record: SessionBeadRecord): Promise<void>;
  };
}

// A CommitFn is the seam the turn loop depends on. Tests pass a fake; production
// passes commitBundle bound to real deps.
export type CommitFn = (input: CommitInput) => Promise<CommitReport>;

function defaultBd(kshetra: KshetraConfig): BdRunner {
  return async (args) => {
    const { stdout } = await execFileAsync('bd', args, {
      env: { ...process.env, BEADS_DIR: kshetra.beads.path },
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  };
}

function shortSha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
}

// Commit the confirmed bundle. Ordering (§7, filing.ts): write the doc (if any),
// create the session bead, then file each remaining plan step — epic first (its
// id resolves the children's `--parent`), children next (their ids resolve dep
// endpoints), dep edges last — journaling each into the session bead as it lands.
// Idempotent by reconcile: a re-run reads the journal and files only what is
// missing. A step failure stops the run and is reported with what already landed.
export async function commitBundle(input: CommitInput, deps: CommitDeps = {}): Promise<CommitReport> {
  const { kshetra } = input;
  const bd = deps.bd ?? defaultBd(kshetra);
  const store = deps.sessionBead ?? new SessionBeadStore(kshetra);

  // Decide the doc path up front so it is part of the immutable session-bead
  // spine even when the body is written later (xa0.6).
  const docRelPath = input.doc?.relPath ?? designDocRelPath(input.decomposition.epic.title);

  // If a doc body is present, stamp its path into the descriptions so every filed
  // bead links it for on-demand read (§8); the plan is compiled from the LINKED
  // decomposition so the link ships in the `bd create -d` argv.
  const decomposition = input.doc
    ? linkDocIntoDecomposition(input.decomposition, docRelPath)
    : input.decomposition;
  const plan: FilingPlan = compileFilingPlan(decomposition);

  const report: CommitReport = { ok: false, childIds: {}, depsAdded: [], errors: [] };

  // Create the spine. A failure here means nothing downstream can be journaled —
  // report and bail.
  let record: SessionBeadRecord;
  let beadId: string;
  try {
    const plspan: SessionPlan = { decomposition, docPath: docRelPath };
    const created = await store.create(plspan);
    beadId = created.id;
    record = created.record;
    report.sessionBeadId = beadId;
  } catch (err) {
    report.errors.push(`session bead create failed: ${(err as Error).message}`);
    return report;
  }

  // Write the doc (server authors the file — §6.2) before filing beads, and
  // journal its sha so a resume knows it landed.
  if (input.doc) {
    try {
      const ref = writeDesignDoc({ kshetra, relPath: docRelPath, content: input.doc.content });
      record = recordDocWritten(record, shortSha(input.doc.content));
      await store.journal(beadId, record);
      report.docRelPath = ref.relPath;
    } catch (err) {
      report.errors.push(`design-doc write failed: ${(err as Error).message}`);
      return report;
    }
  }

  const epicRef = decomposition.epic.ref;
  const refToId: Record<string, string> = {};
  if (record.journal.epicId) refToId[epicRef] = record.journal.epicId;
  for (const [ref, id] of Object.entries(record.journal.childIds)) refToId[ref] = id;

  // File only what the journal shows still missing (reconcile — Q2).
  const remaining = reconcile(record);
  for (const step of remaining.steps) {
    try {
      const argv = resolveStepArgv(step, refToId);
      const out = await bd(argv);
      if (step.kind === 'create') {
        const id = out.trim();
        if (!id) throw new Error(`bd create returned no id for ref "${step.ref}"`);
        refToId[step.ref] = id;
        record = step.ref === epicRef
          ? recordEpicFiled(record, id)
          : recordChildFiled(record, step.ref, id);
      } else {
        record = recordDepAdded(record, step);
      }
      await store.journal(beadId, record);
    } catch (err) {
      report.errors.push(`filing stopped at ${describeStep(step)}: ${(err as Error).message}`);
      break;
    }
  }

  report.epicId = record.journal.epicId;
  report.childIds = { ...record.journal.childIds };
  report.depsAdded = [...record.journal.depsAdded];
  report.ok = report.errors.length === 0 && reconcile(record).steps.length === 0;
  return report;
}

function describeStep(step: FilingPlan['steps'][number]): string {
  return step.kind === 'create'
    ? `create "${step.ref}"`
    : `dep ${step.blockedRef} <- ${step.blockerRef}`;
}

// Bind commitBundle to a Kshetra for use as the turn loop's CommitFn dependency.
export function makeCommitFn(deps: CommitDeps = {}): CommitFn {
  return (input) => commitBundle(input, deps);
}
