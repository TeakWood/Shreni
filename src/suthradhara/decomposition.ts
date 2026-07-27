// The Stage-3 decomposition proposal (ARD §6.1) — the structured object the
// model produces once the readiness rubric is met and the operator reaches the
// decompose stage. It is the machine-readable counterpart to the copy-paste
// proposal prompt.ts describes: a parent epic, its children (each sized for one
// Silpi ↔ Viharapala pass), and the dependency edges that order them.
//
// This file owns the SHAPE and its validation only. It never touches beads:
// nothing here files anything (filing.ts compiles it into `bd` argv;
// confirm.ts gates when that runs). Children reference each other and the epic
// by a *symbolic ref* the model chooses (e.g. "auth-api", "auth-ui") — real
// bead IDs don't exist until commit time (xa0.6), so the proposal must be
// expressible before a single write. Validation rejects a proposal that could
// not file cleanly: unknown types, out-of-range priorities, duplicate or
// dangling refs, self-dependencies, and dependency cycles.

// The bead types Suthradhara may file (xa0.4 scope: epic/task/bug/feature). A
// parent is an `epic` (or `feature` when the work is small enough not to warrant
// an epic); children are the unit-of-work types. Deliberately narrower than
// bd's full type set — Suthradhara has no reason to file a `decision` or
// `chore`, and enumerating keeps the write surface auditable.
export type BeadType = 'epic' | 'feature' | 'task' | 'bug';

export const BEAD_TYPES: readonly BeadType[] = ['epic', 'feature', 'task', 'bug'] as const;

// Types allowed for the parent (an epic groups children; a feature can stand in
// for a lightweight grouping) and for children (concrete units of work).
export const PARENT_TYPES: readonly BeadType[] = ['epic', 'feature'] as const;
export const CHILD_TYPES: readonly BeadType[] = ['task', 'feature', 'bug'] as const;

// Priority is bd's 0-4 scale (0 = highest). Stored as a number here; filing.ts
// stringifies it for the `-p` flag.
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 4;

export interface ProposedEpic {
  // Symbolic ref the children point at via `parentRef`. Unique within the
  // proposal; resolved to a real bead ID at commit time.
  ref: string;
  title: string;
  type: BeadType; // must be one of PARENT_TYPES
  priority: number;
  description?: string;
}

export interface ProposedChild {
  ref: string;
  title: string;
  type: BeadType; // must be one of CHILD_TYPES
  priority: number;
  // The observable, testable definition of done for this unit of work. Required
  // — a child without acceptance criteria is exactly the "half-formed bead"
  // Suthradhara exists to refuse (§4.1).
  acceptanceCriteria: string;
  description?: string;
}

// A dependency edge between two children: `blocked` cannot start until `blocker`
// is done. Both are child refs (an epic parent is a grouping, not a blocker).
// Files as `bd dep add <blocked> <blocker>` (blocked depends-on blocker).
export interface ProposedDep {
  blocked: string;
  blocker: string;
}

export interface Decomposition {
  epic: ProposedEpic;
  children: ProposedChild[];
  deps: ProposedDep[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

function isBlank(s: string | undefined): boolean {
  return s === undefined || s.trim() === '';
}

function priorityInRange(p: number): boolean {
  return Number.isInteger(p) && p >= MIN_PRIORITY && p <= MAX_PRIORITY;
}

// Depth-first cycle check over the child dependency graph. Edge blocked→blocker
// means "blocked waits for blocker"; a cycle is an unschedulable proposal (and
// bd would reject it at `dep add`), so we catch it here where the operator can
// still edit. Refs are assumed already validated as known and non-self.
function hasCycle(children: ProposedChild[], deps: ProposedDep[]): boolean {
  const adj = new Map<string, string[]>();
  for (const c of children) adj.set(c.ref, []);
  for (const d of deps) adj.get(d.blocked)?.push(d.blocker);

  const UNVISITED = 0, IN_STACK = 1, DONE = 2;
  const mark = new Map<string, number>();
  for (const c of children) mark.set(c.ref, UNVISITED);

  const visit = (ref: string): boolean => {
    mark.set(ref, IN_STACK);
    for (const next of adj.get(ref) ?? []) {
      const m = mark.get(next);
      if (m === IN_STACK) return true;
      if (m === UNVISITED && visit(next)) return true;
    }
    mark.set(ref, DONE);
    return false;
  };

  for (const c of children) {
    if (mark.get(c.ref) === UNVISITED && visit(c.ref)) return true;
  }
  return false;
}

// Validate a decomposition against everything that would make filing fail or
// produce a malformed epic. Returns ALL errors, not just the first, so the
// operator can fix a proposal in one editing pass rather than whack-a-mole.
export function validateDecomposition(d: Decomposition): ValidationResult {
  const errors: string[] = [];

  // --- Epic ---
  if (isBlank(d.epic.ref)) errors.push('Epic ref is empty.');
  if (isBlank(d.epic.title)) errors.push('Epic title is empty.');
  if (!PARENT_TYPES.includes(d.epic.type)) {
    errors.push(`Epic type "${d.epic.type}" is not one of: ${PARENT_TYPES.join(', ')}.`);
  }
  if (!priorityInRange(d.epic.priority)) {
    errors.push(`Epic priority ${d.epic.priority} is out of range ${MIN_PRIORITY}-${MAX_PRIORITY}.`);
  }

  // --- Children ---
  if (d.children.length === 0) {
    errors.push('A decomposition needs at least one child bead.');
  }

  // Refs must be unique across the whole proposal (epic + children) — filing
  // keys the ref→id map on them, so a collision would misroute a dependency.
  const seen = new Map<string, number>();
  const bump = (ref: string) => seen.set(ref, (seen.get(ref) ?? 0) + 1);
  if (!isBlank(d.epic.ref)) bump(d.epic.ref);
  for (const c of d.children) if (!isBlank(c.ref)) bump(c.ref);
  for (const [ref, count] of seen) {
    if (count > 1) errors.push(`Ref "${ref}" is used ${count} times; refs must be unique.`);
  }

  for (const [i, c] of d.children.entries()) {
    const where = `Child #${i + 1}${isBlank(c.ref) ? '' : ` ("${c.ref}")`}`;
    if (isBlank(c.ref)) errors.push(`${where} has an empty ref.`);
    if (isBlank(c.title)) errors.push(`${where} has an empty title.`);
    if (isBlank(c.acceptanceCriteria)) {
      errors.push(`${where} has no acceptance criteria — every child needs a testable definition of done.`);
    }
    if (!CHILD_TYPES.includes(c.type)) {
      errors.push(`${where} type "${c.type}" is not one of: ${CHILD_TYPES.join(', ')}.`);
    }
    if (!priorityInRange(c.priority)) {
      errors.push(`${where} priority ${c.priority} is out of range ${MIN_PRIORITY}-${MAX_PRIORITY}.`);
    }
  }

  // --- Dependency edges ---
  // Only child refs are valid endpoints (the epic is a grouping, not a blocker).
  const childRefs = new Set(d.children.map(c => c.ref).filter(r => !isBlank(r)));
  let depsResolvable = true;
  for (const [i, dep] of d.deps.entries()) {
    const where = `Dependency #${i + 1} (${dep.blocked} ← ${dep.blocker})`;
    if (dep.blocked === dep.blocker) {
      errors.push(`${where} is a self-dependency.`);
      depsResolvable = false;
    }
    if (!childRefs.has(dep.blocked)) {
      errors.push(`${where} references unknown child ref "${dep.blocked}".`);
      depsResolvable = false;
    }
    if (!childRefs.has(dep.blocker)) {
      errors.push(`${where} references unknown child ref "${dep.blocker}".`);
      depsResolvable = false;
    }
  }

  // Cycle detection only makes sense once every edge resolves to real children.
  if (depsResolvable && hasCycle(d.children, d.deps)) {
    errors.push('Dependency edges form a cycle; the children cannot be ordered.');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
