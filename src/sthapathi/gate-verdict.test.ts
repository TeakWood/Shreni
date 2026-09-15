import { describe, it, expect } from 'vitest';
import { gateLedgerVerdict } from './dispatch.js';
import type { GateResult } from './gates.js';

function gate(overrides: Partial<GateResult>): GateResult {
  return { gate: 'coverage', level: 'warn', passed: true, skipped: false, reason: '', ...overrides };
}

describe('gateLedgerVerdict (4a2.10)', () => {
  it('records a skipped gate as skip, NOT pass — even though passed:true', () => {
    // coverage/diffSize with no configured command / unmeasurable diff.
    expect(gateLedgerVerdict(gate({ passed: true, skipped: true }))).toBe('skip');
  });

  it('records a genuine pass (ran and passed) as pass', () => {
    expect(gateLedgerVerdict(gate({ passed: true, skipped: false }))).toBe('pass');
  });

  it('records a blocking failure as fail', () => {
    expect(gateLedgerVerdict(gate({ gate: 'test', level: 'block', passed: false, skipped: false }))).toBe('fail');
  });

  it('records a warn-level failure as warn', () => {
    expect(gateLedgerVerdict(gate({ level: 'warn', passed: false, skipped: false }))).toBe('warn');
  });

  it('skip takes precedence over level — a skipped block gate is still skip', () => {
    expect(gateLedgerVerdict(gate({ gate: 'test', level: 'block', passed: true, skipped: true }))).toBe('skip');
  });
});
