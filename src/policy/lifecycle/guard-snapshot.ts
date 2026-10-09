import { createHash } from 'crypto';
import type { GuardFn } from '../../taskgraph';

// The engine's lifecycle hash covers guard names, not their code (engine spec,
// "Versions and upgrades"). This snapshot covers the code: each guard's source,
// hashed, recorded with the lifecycle version it belongs to.

export type GuardSnapshot = { version: number; guards: Record<string, string> };

/**
 * A guard's source as it bears on behaviour: comments, whitespace and the
 * names a bundler gives imports (vite's __vite_ssr_import_N__) don't count,
 * so only a change to the code itself changes the hash.
 */
export function normalizeSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/__vite_ssr_import_\d+__\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const hashGuardSources = (guards: Readonly<Record<string, GuardFn>>): Record<string, string> =>
  Object.fromEntries(Object.entries(guards).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, fn]) => [name, createHash('sha256').update(normalizeSource(fn.toString())).digest('hex').slice(0, 16)]));

/**
 * What's wrong with the recorded snapshot for the current version and guards:
 * a guard whose source changed without a version bump, or a bump whose
 * snapshot wasn't recorded. Empty when they agree.
 */
export function guardSnapshotProblems(version: number, guards: Readonly<Record<string, GuardFn>>, snapshot: GuardSnapshot): string[] {
  const now = hashGuardSources(guards);
  if (snapshot.version !== version) {
    return [`the lifecycle is version ${version}, but the guard snapshot is for ${snapshot.version}: record it (SHRENI_RECORD_GUARDS=1 pnpm vitest run src/policy/lifecycle)`];
  }
  const names = [...new Set([...Object.keys(now), ...Object.keys(snapshot.guards)])].sort();
  return names.filter(n => now[n] !== snapshot.guards[n]).map(n =>
    now[n] === undefined ? `guard ${n} is in the snapshot but no longer exists: bump the lifecycle version`
      : snapshot.guards[n] === undefined ? `guard ${n} is new: bump the lifecycle version and record the snapshot`
        : `guard ${n}'s source changed under version ${version}: bump the lifecycle version, then record the snapshot`);
}
