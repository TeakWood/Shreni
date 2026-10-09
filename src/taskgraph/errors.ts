// Typed errors with stable codes (engine spec, "API"). Callers branch on
// `code`, never on the message.

export class TaskGraphError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = code;
  }
}

/** A call needs a migration that hasn't run on this database. */
export class SchemaBehind extends TaskGraphError {
  constructor(readonly migration: string) {
    super('SchemaBehind', `the database schema is behind: migration ${migration} has not run (run migrate)`);
  }
}
