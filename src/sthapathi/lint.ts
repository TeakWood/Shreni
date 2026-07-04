import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KshetraConfig } from '../kshetra/config.js';
import { resolveLintCommand, splitCommand } from '../kshetra/toolchain.js';

const execFileAsync = promisify(execFile);

export interface LintResult {
  // passed is true when the linter exited 0 OR no lint gate is configured
  // (skipped). skipped distinguishes "ran and passed" from "no gate".
  passed: boolean;
  skipped: boolean;
  raw: string;
}

// Run the configured lint command as an independent gate (mirroring the
// build/test gates), replacing the old soft-trust of Silpi's self-reported
// lintPassed (the toolchain design §3.3). When stack.lintCommand is unset the language
// default applies; an empty resolved command means the Kshetra has no lint step,
// which is a visible, logged skip — never synthesised for a repo without a
// linter. Resolves (never rejects); a non-zero exit yields passed=false.
export async function runLintGate(kshetra: KshetraConfig): Promise<LintResult> {
  const [cmd, ...args] = splitCommand(resolveLintCommand(kshetra));
  if (!cmd) {
    console.warn(`[lint] ${kshetra.id}: no lint command configured — lint gate skipped`);
    return { passed: true, skipped: true, raw: '(no lint command configured — lint gate skipped)' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: kshetra.repo.path,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { passed: true, skipped: false, raw: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
    return { passed: false, skipped: false, raw };
  }
}