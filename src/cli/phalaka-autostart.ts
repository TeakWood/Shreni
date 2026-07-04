import {
  startPhalaka,
  stopPhalaka,
  type PhalakaStartResult,
  type PhalakaStopResult,
} from './phalaka';

// Auto-start/stop wiring for the Phalaka dashboard, factored out of cli/index.ts
// so the opt-out logic is unit-testable with a mocked spawn.

// The dashboard is on by default; opt out per-invocation with --no-dashboard or
// globally (headless/CI) with PHALAKA_DISABLE=1.
export function isDashboardDisabled(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--no-dashboard') || env['PHALAKA_DISABLE'] === '1';
}

export type AutoStartResult = PhalakaStartResult | { status: 'disabled' };

// Called after `shreni start` launches Kshetra workers. Idempotent: startPhalaka
// returns already_running if a live PID exists.
export function autoStartPhalaka(argv: string[], env: NodeJS.ProcessEnv = process.env): AutoStartResult {
  if (isDashboardDisabled(argv, env)) return { status: 'disabled' };
  return startPhalaka();
}

export type AutoStopResult = PhalakaStopResult | { status: 'skipped' };

// Only a full `shreni stop` (no --kshetra) tears down the global dashboard;
// stopping a single Kshetra leaves the board running.
export function autoStopPhalaka(argv: string[]): AutoStopResult {
  if (argv.includes('--kshetra')) return { status: 'skipped' };
  return stopPhalaka();
}