// `shreni show <beadId> [@kshetra]` (epic 4a2.6). Plan and execution now live in
// two stores in the same beads repo: bd holds the issue (title, status,
// acceptance criteria, dependency edges); ledger.jsonl holds what actually
// happened (claim, rounds with verdicts, gate results, policy decisions, usage,
// merge, close). `bd show` cannot join across them — this command can.
//
// It reads the bead via the bd wrapper and the ledger via readLedger (the single
// gated read path, 4a2.1), joins by beadId, and renders one chronological
// timeline. The ledger is read ONLY through readLedger — the raw file bytes are
// parsed by parseLedgerLines and gated by readLedger before anything is rendered,
// never interpreted directly.

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadRegistry } from '../kshetra/registry';
import { resolveTargetKshetra } from './suthradhara';
import { bd, parseAcceptanceCriteria } from '../sthapathi/beads';
import { readLedger, parseLedgerLines } from '../ext/index';
import type { LedgerEntry } from '../ext/index';
import type { KshetraConfig } from '../kshetra/config';

export interface ShowOpts {
  args: string[];
  flagKshetra: string | undefined;
  cwd: string;
  kshetras?: KshetraConfig[];
}

// The bead fields we render as the timeline header. Extracted defensively from
// the `bd show <id> --json` payload (a JSON array whose first matching element is
// the bead); any absent field just renders as a placeholder.
interface BeadHeader {
  id: string;
  title: string;
  status: string;
  type: string;
  priority: number | null;
  criteria: string;
}

function parseBeadHeader(showJson: string): BeadHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(showJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // bd resolves short ids and echoes the CANONICAL id in the payload
  // (`4a2.6` → `Shreni-beads-4a2.6`), so the raw typed arg must NEVER be the join
  // key (4a2.8). bd lists the requested bead first, then its dependencies — take
  // the first bead-like object and read its own id as canonical, then key the
  // header match, acceptance-criteria parse, and ledger filter off THAT.
  const bead = parsed.find(
    (b): b is Record<string, unknown> =>
      typeof b === 'object' && b !== null && typeof (b as { id?: unknown }).id === 'string',
  );
  if (!bead) return null;
  const canonicalId = bead.id as string;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: canonicalId,
    title: str(bead.title),
    status: str(bead.status) || 'unknown',
    type: str(bead.issue_type) || str(bead.type) || 'task',
    priority: typeof bead.priority === 'number' ? bead.priority : null,
    criteria: parseAcceptanceCriteria(showJson, canonicalId),
  };
}

// Read + parse ledger.jsonl for the Kshetra ONCE. This is the only place the file
// is touched; callers derive the bead timeline and the lot manifests from the
// parsed entries through readLedger (the gated read path) — the CLI never
// interprets a raw entry itself. A missing ledger (nothing decision-grade has
// happened yet) is empty, not an error.
function loadLedger(kshetra: KshetraConfig): LedgerEntry[] {
  const path = join(kshetra.beads.path, 'ledger.jsonl');
  try {
    return parseLedgerLines(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// The bead's chronological timeline. `shreni show` is an operator/audit tool, so
// it reads at 'audit' clearance — it sees every entry the bead recorded. Sorted
// by ts so a clock skew / interleaved sink lines don't misorder it.
function beadTimeline(all: LedgerEntry[], beadId: string): LedgerEntry[] {
  return readLedger(all, beadId, { audience: 'audit' })
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// The lot manifests (worker_started, epic yrk / Study B2) indexed by lotId. They
// are lot-level (beadId ''), so they surface via the '' bead query at audit
// clearance; a bead's timeline entries join to them by their envelope lotId.
function lotManifests(all: LedgerEntry[]): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>();
  for (const m of readLedger(all, '', { audience: 'audit' })) {
    if (m.kind === 'worker_started' && m.lotId) map.set(m.lotId, m);
  }
  return map;
}

// ── rendering ────────────────────────────────────────────────────────────────

// Compact, stable timestamp (UTC, no locale): "2026-09-16 03:12:44".
function fmtTs(ts: string): string {
  return ts.length >= 19 ? `${ts.slice(0, 10)} ${ts.slice(11, 19)}` : ts;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// One timeline line per entry: a fixed-width label + a kind-specific one-liner
// read from the payload. Unknown (forward-compat) kinds still render — this file
// is meant to be read years later — as the kind plus its compact payload.
function fmtEntry(e: LedgerEntry): string {
  const p = e.payload;
  const label = (l: string): string => l.padEnd(10);
  let body: string;
  switch (e.kind) {
    case 'task_claimed':
      body = `${label('CLAIMED')}${text(p.title)}`;
      break;
    case 'run_started':
      body = `${label('RUN')}${text(p.agent)} ${text(p.provider)}/${text(p.model)}`;
      break;
    case 'policy_decision':
      body =
        p.policy === 'mayProceed'
          ? `${label('POLICY')}mayProceed ${p.allowed ? 'allow' : `DENY (${text(p.reason)})`}`
          : `${label('POLICY')}selectModel → ${text(p.provider)}/${text(p.model)}`;
      break;
    case 'gate_result':
      body = `${label('GATE')}${text(p.gate)}: ${text(p.verdict)}${p.round ? ` (R${num(p.round)})` : ''}`;
      break;
    case 'silpi_done':
      body = `${label('SILPI')}R${num(p.round)} conf=${num(p.confidence)} lint=${p.lintPassed ? '✓' : '✗'} tests=${p.testsPassed ? '✓' : '✗'}`;
      break;
    case 'viharapala_done':
      body = `${label('REVIEW')}R${num(p.round)} ${text(p.verdict)} score=${num(p.score)}`;
      break;
    case 'run_usage':
      body = `${label('USAGE')}${text(p.agent)} in=${num(p.inputTokens)} out=${num(p.outputTokens)} cost=${p.priced ? `$${(num(p.costUsd) ?? 0).toFixed(4)}` : 'unpriced'} (${text(p.outcome)})`;
      break;
    case 'merge_done':
      body = `${label('MERGE')}${text(p.mergePolicy)}${p.sha ? ` ${text(p.sha).slice(0, 12)}` : ''}${p.pr ? ` PR#${num(p.pr)}` : ''}`;
      break;
    case 'context_compacted': {
      // e.g. "context compacted (auto, 187k tokens before)". The compaction is a
      // decision-grade audit record (epic 408): from this point the agent worked
      // from a summary of its own earlier work.
      const pre = num(p.preTokens);
      const preStr = pre === undefined ? '?' : pre >= 1000 ? `${Math.round(pre / 1000)}k` : String(pre);
      body = `${label('COMPACT')}context compacted (${text(p.trigger) || 'unknown'}, ${preStr} tokens before)`;
      break;
    }
    case 'task_done':
      body = `${label('DONE')}${p.approved ? 'APPROVED' : 'BLOCKED'} (${num(p.rounds)} round${num(p.rounds) === 1 ? '' : 's'})`;
      break;
    case 'review_ablated': {
      // Epic 8wi: a round merged WITHOUT review. Must NEVER read as an approval.
      const abls = Array.isArray(p.ablations) ? (p.ablations as unknown[]).map(String).join(', ') : 'review';
      body = `${label('ABLATED')}round ${num(p.round)} — merged WITHOUT review (ablation: ${abls})`;
      break;
    }
    default:
      body = `${label(e.kind)}${JSON.stringify(p)}`;
  }
  return `  ${fmtTs(e.ts)}  ${body}`;
}

// ── lot manifest header (epic yrk / Study B2, yrk.5) ─────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// The distinct lots a bead's timeline touched, in first-seen (chronological)
// order. An entry with no lotId (pre-B2 history) contributes a single `null`
// "unknown lot" once. So a bead worked across a worker restart lists every lot.
function distinctLots(entries: LedgerEntry[]): (string | null)[] {
  const seen = new Set<string>();
  const out: (string | null)[] = [];
  let sawUnknown = false;
  for (const e of entries) {
    if (e.lotId === undefined) {
      if (!sawUnknown) { sawUnknown = true; out.push(null); }
      continue;
    }
    if (!seen.has(e.lotId)) { seen.add(e.lotId); out.push(e.lotId); }
  }
  return out;
}

function shortSha(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 12) : '?';
}
// "sha256:9ce70da6de26…" → "sha256:9ce70da6" (short but still discriminating).
function shortHash(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) return '?';
  const m = /^sha256:([0-9a-f]{8})/.exec(v);
  return m ? `sha256:${m[1]}` : v.slice(0, 16);
}

function fmtGates(gates: unknown): string {
  const g = obj(gates);
  const parts = Object.keys(g).map(k => `${k}=${text(g[k])}`);
  return parts.length ? parts.join(' ') : '?';
}

function fmtRoles(roles: unknown): string {
  const r = obj(roles);
  const parts = Object.keys(r).map(role => {
    const o = obj(r[role]);
    return `${role}=${text(o.provider) || '?'}/${text(o.model) || '?'}`;
  });
  return parts.length ? parts.join(' ') : '?';
}

function fmtShreni(shreni: unknown): string {
  const s = obj(shreni);
  const version = text(s.version) || '?';
  const commit = typeof s.commit === 'string' && s.commit.length > 0
    ? (s.commit === 'unknown' ? 'unknown' : s.commit.slice(0, 7))
    : 'null';
  return `${version}@${commit}${s.dirty === true ? ' (dirty)' : ''}`;
}

function fmtProviders(providers: unknown): string {
  const p = obj(providers);
  const parts = Object.keys(p).map(name => {
    const o = obj(p[name]);
    return `${name}=${o.version != null ? text(o.version) : `(${text(o.error) || 'unknown'})`}`;
  });
  return parts.length ? parts.join(' ') : '?';
}

function fmtTool(tool: unknown): string {
  const o = obj(tool);
  return o.version != null ? text(o.version) : '(unknown)';
}

function fmtExtension(extension: unknown): string {
  const e = obj(extension);
  if (e.loaded !== true) return 'none';
  const overrode = Array.isArray(e.overrode) && e.overrode.length ? ` overrode ${(e.overrode as unknown[]).map(String).join(',')}` : '';
  return `${text(e.path) || '?'} ${shortHash(e.contentHash)}${overrode}`;
}

// Render one lot's compact manifest block. `m` undefined means the lot has no
// worker_started recorded — a pre-B2 entry (lotId null) or a lotId whose manifest
// is missing; both render a single explanatory line, never an error.
function fmtLotManifest(lotId: string | null, m: LedgerEntry | undefined): string[] {
  const short = lotId ? lotId.slice(0, 8) : '(unknown)';
  if (!m) {
    return [`  Lot ${short} — ${lotId ? 'no manifest recorded for this lot' : 'no manifest (pre-B2 history)'}`];
  }
  const p = m.payload;
  const subject = obj(p.subject);
  const proc = obj(p.process);
  const repo = obj(subject.repo);
  const config = obj(subject.config);
  const tools = obj(proc.tools);
  const labels = obj(p.labels);

  const labelStr = Object.keys(labels).length
    ? Object.entries(labels).map(([k, v]) => `${k}=${text(v)}`).join(' ')
    : '(none)';
  const clean = repo.clean === true ? 'clean' : repo.clean === false ? 'DIRTY' : 'clean?';

  return [
    `  Lot ${short} · ${fmtTs(m.ts)} · ${text(p.entrypoint) || '?'} · labels: ${labelStr}`,
    `    base: ${shortSha(repo.baseSha)} (${clean})   config: ${shortHash(config.resolvedConfigHash)}   gates: ${fmtGates(config.gates)}`,
    `    models: ${fmtRoles(config.roles)}`,
    `    shreni: ${fmtShreni(proc.shreni)}   providers: ${fmtProviders(proc.providers)}   bd: ${fmtTool(tools.bd)}   node: ${text(tools.node) || '?'}`,
    `    extension: ${fmtExtension(proc.extension)}`,
  ];
}

// Whether the KNOWN manifests a bead spans disagree on the enforced config or the
// Shreni build — the audit-relevant case a multi-lot bead surfaces (yrk.5).
function lotDivergence(manifests: LedgerEntry[]): { config: boolean; build: boolean } {
  const hashes = new Set<string>();
  const builds = new Set<string>();
  for (const m of manifests) {
    const config = obj(obj(m.payload.subject).config);
    hashes.add(text(config.resolvedConfigHash));
    const s = obj(obj(m.payload.process).shreni);
    builds.add(`${text(s.version)}@${text(s.commit)}#${String(s.dirty)}`);
  }
  return { config: hashes.size > 1, build: builds.size > 1 };
}

// The lot-manifest section: one block per lot the bead's timeline touched, plus a
// divergence marker when it spanned lots that enforced different conditions.
function renderLotSection(entries: LedgerEntry[], manifests: Map<string, LedgerEntry>): string[] {
  const lots = distinctLots(entries);
  if (lots.length === 0) return [];
  const lines: string[] = [lots.length === 1 ? 'Lot manifest:' : 'Lot manifests:'];
  const known: LedgerEntry[] = [];
  for (const lot of lots) {
    const m = lot ? manifests.get(lot) : undefined;
    if (m) known.push(m);
    lines.push(...fmtLotManifest(lot, m));
  }
  if (known.length > 1) {
    const d = lotDivergence(known);
    // Exact phrasing kept stable for the acceptance/snapshot.
    if (d.config) lines.push('  ⚠ configuration changed between lots');
    if (d.build) lines.push('  ⚠ Shreni build changed between lots');
  }
  lines.push('');
  return lines;
}

export function renderShow(
  header: BeadHeader,
  entries: LedgerEntry[],
  manifests: Map<string, LedgerEntry> = new Map(),
): string {
  const lines: string[] = [];
  lines.push(`Bead ${header.id}${header.title ? ` — ${header.title}` : ''}`);
  const pr = header.priority === null ? '' : ` · P${header.priority}`;
  lines.push(`Status: ${header.status} · Type: ${header.type}${pr}`);
  if (header.criteria) {
    lines.push('');
    lines.push('Acceptance criteria:');
    for (const line of header.criteria.split('\n')) lines.push(`  ${line}`);
  }
  lines.push('');
  // The governing lot manifest(s) — the conditions each worker ran this bead
  // under (epic yrk / Study B2) — as a header above the timeline.
  lines.push(...renderLotSection(entries, manifests));
  if (entries.length === 0) {
    lines.push('Timeline: no ledger entries for this bead.');
  } else {
    lines.push(`Timeline (${entries.length} ledger ${entries.length === 1 ? 'entry' : 'entries'}):`);
    for (const e of entries) lines.push(fmtEntry(e));
  }
  return lines.join('\n');
}

// ── command entry ────────────────────────────────────────────────────────────

// Flags on `shreni show` that consume the following token as their value; a bead
// id must never be confused with one of those values.
const VALUE_FLAGS = new Set(['--kshetra']);

// The bead id is the first positional that is neither an @-mention (that selects
// the Kshetra) nor a flag nor a flag's value. ctx.args keeps flags inline
// (registry.ts), so `show --kshetra myapp b1` must skip both `--kshetra` and
// `myapp` and still return `b1`.
function firstBeadId(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('@')) continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++; // also skip this flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

export async function runShow(opts: ShowOpts): Promise<void> {
  const beadId = firstBeadId(opts.args);
  if (!beadId) throw new Error('Usage: shreni show <beadId> [@<kshetra> | --kshetra <id>]');

  const kshetras = opts.kshetras ?? loadRegistry();
  const kshetra = resolveTargetKshetra(opts.args, opts.flagKshetra, opts.cwd, kshetras);

  // The bead itself. bd exits non-zero for an unknown id — surface a clear
  // message rather than a raw bd stack.
  let showJson: string;
  try {
    showJson = await bd(kshetra).show(beadId);
  } catch (err) {
    throw new Error(`Bead not found in ${kshetra.id}: ${beadId} (${(err as Error).message})`);
  }
  const header = parseBeadHeader(showJson);
  if (!header) throw new Error(`Bead not found in ${kshetra.id}: ${beadId}`);

  // Join the ledger on the CANONICAL id from the payload, not the raw arg — the
  // ledger stores canonical ids, so a short-id filter would drop every entry. Read
  // once, then derive both the timeline and the lot manifests it references.
  const all = loadLedger(kshetra);
  const entries = beadTimeline(all, header.id);
  const manifests = lotManifests(all);
  console.log(renderShow(header, entries, manifests));
}
