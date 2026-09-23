import { describe, it, expect } from 'vitest';
import { parseCoverageSummary, formatCoverageSummary } from './coverage-summary.js';

describe('parseCoverageSummary (Shreni-beads-06z)', () => {
  it('reads an istanbul/nyc text-summary (the eslint-shreni shape)', () => {
    const raw = [
      '  1234 passing (3m)',
      '=============================== Coverage summary ===============================',
      'Statements   : 99.4% ( 30120/30301 )',
      'Branches     : 98.33% ( 17000/17289 )',
      'Functions    : 99.6% ( 4000/4016 )',
      'Lines        : 99.41% ( 29800/29976 )',
      '================================================================================',
    ].join('\n');
    expect(parseCoverageSummary(raw)).toEqual({ statements: 99.4, branches: 98.33, functions: 99.6, lines: 99.41 });
  });

  it('reads the "All files" row of an istanbul/vitest text table by header column', () => {
    const raw = [
      '----------|---------|----------|---------|---------|-------------------',
      'File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s ',
      '----------|---------|----------|---------|---------|-------------------',
      'All files |   87.5  |    75    |   100   |   87.5  |                   ',
      ' math.ts  |   87.5  |    75    |   100   |   87.5  | 12                ',
    ].join('\n');
    expect(parseCoverageSummary(raw)).toEqual({ statements: 87.5, branches: 75, functions: 100, lines: 87.5 });
  });

  it('strips ANSI colour codes and takes the LAST summary when several are printed', () => {
    const raw = '\u001b[32mStatements   : 50% ( 1/2 )\u001b[0m\nStatements   : 91.2% ( 912/1000 )\n';
    expect(parseCoverageSummary(raw)).toEqual({ statements: 91.2 });
  });

  it('reads coverage.py, go tool cover -func and tarpaulin single figures', () => {
    expect(parseCoverageSummary('Name  Stmts  Miss  Cover\nTOTAL   1234   56   95%\n')).toEqual({ statements: 95 });
    expect(parseCoverageSummary('pkg/a.go:10: F  100.0%\ntotal:\t\t\t(statements)\t85.0%\n')).toEqual({ statements: 85 });
    expect(parseCoverageSummary('85.00% coverage, 100/120 lines covered')).toEqual({ lines: 85 });
  });

  it('returns null for output with no coverage summary (a plain test run)', () => {
    expect(parseCoverageSummary('  1234 passing (3m)\n  0 failing\n')).toBeNull();
    expect(parseCoverageSummary('')).toBeNull();
  });

  it('ignores out-of-range percentages rather than recording them', () => {
    expect(parseCoverageSummary('Statements   : 150% ( 3/2 )')).toBeNull();
  });

  it('formats only the metrics present', () => {
    expect(formatCoverageSummary({ statements: 99.4, lines: 99.41 })).toBe('statements 99.4% · lines 99.41%');
  });
});
