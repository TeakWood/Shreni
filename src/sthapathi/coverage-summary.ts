// Coverage summary extraction for the coverage gate (Shreni-beads-06z). The gate
// runs the repo's own coverage command (delegate-first — Shreni never restates
// how a project measures coverage), so the numbers only exist as that command's
// printed output. This reads the common summary shapes out of it; it is
// best-effort by design: an unrecognised format yields null, which the gate
// reports as "no coverage summary" rather than guessing.
//
// Recognised (ANSI colour codes stripped first; the LAST match wins, since a
// multi-project run prints the overall summary last):
//   istanbul/nyc/c8/jest/vitest text-summary   "Statements   : 99.4% ( 1234/1241 )"
//   istanbul/nyc/c8/jest/vitest text table     "All files |  99.4 |  98.33 |  99.6 |  99.4 |"
//   coverage.py report                         "TOTAL   1234   56   95%"
//   go tool cover -func                        "total:  (statements)  85.0%"
//   cargo-tarpaulin                            "85.00% coverage, 100/120 lines covered"

// Percentages, 0–100. A metric the tool did not report is absent, never 0.
export interface CoverageSummary {
  statements?: number;
  branches?: number;
  functions?: number;
  lines?: number;
}

export type CoverageMetric = keyof CoverageSummary;
export const COVERAGE_METRICS: readonly CoverageMetric[] = ['statements', 'branches', 'functions', 'lines'];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function pct(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

function lastMatch(text: string, re: RegExp): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m as RegExpExecArray;
  return last;
}

// istanbul text-summary: one "<Metric> : NN.NN% ( a/b )" line per metric.
function fromTextSummary(text: string): CoverageSummary | null {
  const out: CoverageSummary = {};
  const names: Array<[CoverageMetric, string]> = [
    ['statements', 'Statements'], ['branches', 'Branches'], ['functions', 'Functions'], ['lines', 'Lines'],
  ];
  for (const [key, label] of names) {
    const m = lastMatch(text, new RegExp(`^\\s*${label}\\s*:\\s*([\\d.]+)%`, 'gm'));
    const v = pct(m?.[1]);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// istanbul text table: map the "All files" row's cells by the header's columns.
function fromTextTable(text: string): CoverageSummary | null {
  const lines = text.split('\n');
  let header: string[] | undefined;
  let row: string[] | undefined;
  for (const line of lines) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 3) continue;
    if (cells.some(c => /^% ?Stmts$/i.test(c))) header = cells;
    else if (header && /^All files$/i.test(cells[0])) row = cells;
  }
  if (!header || !row) return null;
  const columns: Array<[CoverageMetric, RegExp]> = [
    ['statements', /^% ?Stmts$/i], ['branches', /^% ?Branch$/i], ['functions', /^% ?Funcs$/i], ['lines', /^% ?Lines$/i],
  ];
  const out: CoverageSummary = {};
  for (const [key, re] of columns) {
    const i = header.findIndex(c => re.test(c));
    const v = i >= 0 ? pct(row[i]) : undefined;
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Single-figure tools. coverage.py's and go's figures are statement coverage;
// tarpaulin's is line coverage.
function fromSingleFigure(text: string): CoverageSummary | null {
  const py = lastMatch(text, /^TOTAL\s+(?:\d+\s+)+([\d.]+)%\s*$/gm);
  if (py) { const v = pct(py[1]); if (v !== undefined) return { statements: v }; }
  const go = lastMatch(text, /^total:\s+\(statements\)\s+([\d.]+)%\s*$/gm);
  if (go) { const v = pct(go[1]); if (v !== undefined) return { statements: v }; }
  const tarpaulin = lastMatch(text, /([\d.]+)% coverage, \d+\/\d+ lines covered/g);
  if (tarpaulin) { const v = pct(tarpaulin[1]); if (v !== undefined) return { lines: v }; }
  return null;
}

// The coverage summary a coverage command printed, or null when none of the
// recognised shapes is present (the command produced no coverage signal).
export function parseCoverageSummary(raw: string): CoverageSummary | null {
  const text = raw.replace(ANSI, '').replace(/\r/g, '');
  return fromTextSummary(text) ?? fromTextTable(text) ?? fromSingleFigure(text);
}

// "statements 99.4% · branches 98.33% · …" — only the metrics present.
export function formatCoverageSummary(s: CoverageSummary): string {
  return COVERAGE_METRICS.filter(k => s[k] !== undefined).map(k => `${k} ${s[k]}%`).join(' · ');
}
