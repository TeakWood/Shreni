// Compile a validated Decomposition into an ordered filing plan — the exact
// `bd` invocations that, run top to bottom, create the parent epic, its
// children, and the dependency edges between them (ARD §6.1, §7). This file
// produces the plan; it does NOT run it. Execution — capturing each `--silent`
// id, resolving cross-refs, and reporting partial failure — is xa0.6.
//
// The plan is built as argv ARRAYS, never shell strings, and every operator-
// supplied value (title, description, acceptance criteria) is its own argv
// element. That is the argument-hygiene guarantee: the executor runs
// execFile('bd', argv) with no shell, so a title like `"; rm -rf ~"` is filed
// as a literal issue title and executes nothing. There is deliberately no code
// path here that concatenates a value into a command string — the type system
// only lets you hand back string[].
//
// Cross-references (a child's parent, a dep's endpoints) are symbolic refs at
// compile time because real bead IDs don't exist yet. Each create step declares
// the ref it will PRODUCE; resolveStepArgv() turns a step into runnable argv
// given a ref→id map the executor fills in as earlier steps complete.

import type { Decomposition } from './decomposition';

// A step that creates a bead. `ref` is the symbolic id it produces (the
// executor maps ref → the real id `bd create --silent` prints). `parentRef`, if
// present, is resolved to `--parent <id>` at run time. `argv` is the fixed
// prefix that needs no resolution — title/type/priority/acceptance/description,
// all already discrete elements.
export interface CreateStep {
  kind: 'create';
  ref: string;
  parentRef?: string;
  argv: string[];
}

// A step that links two already-created beads. Both refs resolve to real ids at
// run time; there are no free-text arguments, so nothing to sanitise.
export interface DepStep {
  kind: 'dep';
  blockedRef: string;
  blockerRef: string;
}

export type FilingStep = CreateStep | DepStep;

export interface FilingPlan {
  steps: FilingStep[];
}

// Build the `bd create` argv prefix shared by epic and children. Every value is
// pushed as its own element; flags never get interpolated with their values.
// `--silent` makes bd print only the new id, which the executor captures to
// resolve this step's ref.
function createArgv(opts: {
  title: string;
  type: string;
  priority: number;
  acceptanceCriteria?: string;
  description?: string;
  externalRef?: string;
}): string[] {
  const argv = ['create', opts.title, '-t', opts.type, '-p', String(opts.priority)];
  if (opts.acceptanceCriteria !== undefined && opts.acceptanceCriteria.trim() !== '') {
    argv.push('--acceptance', opts.acceptanceCriteria);
  }
  if (opts.description !== undefined && opts.description.trim() !== '') {
    argv.push('-d', opts.description);
  }
  // pmb.7: stamp the external source ref (e.g. jira:PROJ-123) onto the bead so a
  // later consult of the same ticket finds it (route-to-evolve) and the bead
  // traces back to where the requirement lives. Its own argv element — the
  // argument-hygiene guarantee carries through.
  if (opts.externalRef !== undefined && opts.externalRef.trim() !== '') {
    argv.push('--external-ref', opts.externalRef);
  }
  argv.push('--silent');
  return argv;
}

// Compile the decomposition into a plan. Order matters and encodes the
// dependency the executor relies on: the epic first (children need its id for
// `--parent`), then every child (deps need their ids), then the edges. Within
// each group, source order is preserved so the plan reads like the proposal.
// `externalRef` (pmb.7), when set, is stamped onto the epic AND every child so
// the whole filed bundle traces back to its external source of record (e.g.
// jira:PROJ-123) — the same ref a re-consult bd-searches to route to evolve.
export function compileFilingPlan(d: Decomposition, externalRef?: string): FilingPlan {
  const steps: FilingStep[] = [];

  steps.push({
    kind: 'create',
    ref: d.epic.ref,
    argv: createArgv({
      title: d.epic.title,
      type: d.epic.type,
      priority: d.epic.priority,
      description: d.epic.description,
      externalRef,
    }),
  });

  for (const c of d.children) {
    steps.push({
      kind: 'create',
      ref: c.ref,
      parentRef: d.epic.ref,
      argv: createArgv({
        title: c.title,
        type: c.type,
        priority: c.priority,
        acceptanceCriteria: c.acceptanceCriteria,
        description: c.description,
        externalRef,
      }),
    });
  }

  for (const dep of d.deps) {
    steps.push({ kind: 'dep', blockedRef: dep.blocked, blockerRef: dep.blocker });
  }

  return { steps };
}

// Missing ref in the map — the executor called resolveStepArgv before the step
// that produces `ref` completed (or with an out-of-order plan). Surfaced as a
// typed error rather than an `undefined` sneaking into an argv.
export class UnresolvedRefError extends Error {
  constructor(public readonly ref: string) {
    super(`Cannot resolve ref "${ref}" to a bead id: it has not been filed yet.`);
    this.name = 'UnresolvedRefError';
  }
}

// Turn a step into the exact argv to hand execFile('bd', ...). `refToId` maps a
// symbolic ref to the real bead id the executor captured from an earlier step's
// `--silent` output. Pure and side-effect free — the executor owns spawning.
export function resolveStepArgv(
  step: FilingStep,
  refToId: Record<string, string>,
): string[] {
  const resolve = (ref: string): string => {
    const id = refToId[ref];
    if (id === undefined) throw new UnresolvedRefError(ref);
    return id;
  };

  if (step.kind === 'create') {
    const argv = [...step.argv];
    if (step.parentRef !== undefined) argv.push('--parent', resolve(step.parentRef));
    return argv;
  }
  // `bd dep add <blocked> <blocker>`: blocked depends-on (is blocked by) blocker.
  return ['dep', 'add', resolve(step.blockedRef), resolve(step.blockerRef)];
}
