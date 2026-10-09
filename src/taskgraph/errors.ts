// Typed errors with stable codes (engine spec, "API"). Callers branch on
// `code`, never on the message.

export class TaskGraphError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = code;
  }
}

/** Adding the edge would close a cycle: dependsOnId already waits, directly or not, on taskId. */
export class CycleError extends TaskGraphError {
  constructor(readonly taskId: string, readonly dependsOnId: string) {
    super('CycleError', `${taskId} can't depend on ${dependsOnId}: ${dependsOnId} already depends on ${taskId}`);
  }
}

export class NotFound extends TaskGraphError {
  constructor(readonly entity: string, readonly id: string) {
    super('NotFound', `${entity} ${id} not found`);
  }
}

/** A call's input is malformed, or the edit is one the rules forbid. */
export class InvalidRequest extends TaskGraphError {
  constructor(message: string) {
    super('InvalidRequest', message);
  }
}

/** The actor's role may not make this call, or not with the task in its current state. */
export class NotPermitted extends TaskGraphError {
  constructor(readonly call: string, readonly role: string, readonly state?: string) {
    super('NotPermitted', `role ${role} may not call ${call}${state === undefined ? '' : ` on a task in ${state}`}`);
  }
}

/** One validator's finding (engine spec, "Validation"). */
export interface Finding {
  validator: string;
  severity: 'error' | 'warning';
  taskId?: string;
  message: string;
}

/** Validation refused an approval; carries every finding, warnings included. */
export class ValidationError extends TaskGraphError {
  constructor(readonly findings: readonly Finding[]) {
    const errors = findings.filter(f => f.severity === 'error');
    const shown = errors.length ? errors : findings;
    super('ValidationError', `validation failed: ${shown.map(f => f.message).join('; ') || 'no findings'}`);
  }
}

/**
 * A move was refused. `reason` is the guard's string, or one of NotPermitted,
 * ChildrenLive or DependentsLive; DependentsLive also names the waiting tasks.
 */
export class MoveRefused extends TaskGraphError {
  constructor(
    readonly taskId: string,
    readonly state: string,
    readonly reason: string,
    /** DependentsLive: the live tasks that depend on this one. */
    readonly waiting: readonly string[] = [],
    /** ChildrenLive: the children that aren't terminal. */
    readonly children: readonly string[] = [],
  ) {
    const who = (waiting.length ? ` (waiting: ${waiting.join(', ')})` : '')
      + (children.length ? ` (live children: ${children.join(', ')})` : '');
    super('MoveRefused', `move refused on ${taskId} in ${state}: ${reason}${who}`);
  }
}

/** The attempt no longer holds the lease; the worker must abandon it. */
export class LeaseLost extends TaskGraphError {
  constructor(readonly taskId: string, readonly attemptId: string) {
    super('LeaseLost', `attempt ${attemptId} no longer holds ${taskId}`);
  }
}

/** Someone else holds the task's lease. */
export class LeaseHeld extends TaskGraphError {
  constructor(readonly taskId: string, readonly holder: string) {
    super('LeaseHeld', `${taskId} is held by ${holder}`);
  }
}

/** This process is older than the schema's min_writer, or not on the project's lifecycle version. */
export class VersionMismatch extends TaskGraphError {
  constructor(message: string) {
    super('VersionMismatch', message);
  }
}

/** A call needs a migration that hasn't run on this database. */
export class SchemaBehind extends TaskGraphError {
  constructor(readonly migration: string) {
    super('SchemaBehind', `the database schema is behind: migration ${migration} has not run (run migrate)`);
  }
}

/**
 * The database can't be reached, or a transaction gave up after its retries.
 * Safe to retry with the same request id.
 */
export class Unavailable extends TaskGraphError {
  constructor(message: string, cause?: unknown) {
    super('Unavailable', message, cause === undefined ? undefined : { cause });
  }
}

/** One registration rule a lifecycle breaks. */
export interface LifecycleViolation {
  rule: string;
  message: string;
}

/** A lifecycle breaks a registration rule, or changes without a version bump. */
export class LifecycleInvalid extends TaskGraphError {
  constructor(readonly lifecycle: string, readonly violations: readonly LifecycleViolation[]) {
    super('LifecycleInvalid', `lifecycle ${lifecycle} refused: ${violations.map(v => `[${v.rule}] ${v.message}`).join('; ')}`);
  }
}
