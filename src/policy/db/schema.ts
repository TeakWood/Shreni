import type { ColumnType, Generated } from 'kysely';

// Row types for Shreni's tables (migrations/0001_tables.ts), for Kysely.

type Defaulted<T> = ColumnType<T, T | undefined, T>;

/**
 * attempt_evidence.gates. `acceptance.passed` records whether the task's
 * acceptance checks all passed on this attempt: auto checks by the test
 * gate, manual ones on the developer's confirmation (shreni task finish).
 * finish's checksPassed guard reads it.
 */
export type AttemptGates = { acceptance?: { passed: boolean } & Record<string, unknown> } & Record<string, unknown>;

export interface ShreniDatabase {
  'shreni.schema_meta': { only_row: Defaulted<boolean>; version: number; min_writer: number };
  'shreni.projects': {
    project_id: string;
    mode: 'kshetra' | 'tracker';
    repo_url: string | null;
    team: string | null;
    created_at: Defaulted<Date>;
  };
  'shreni.intents': {
    project_id: string;
    plan_id: string;
    statement: string;
    created_at: Defaulted<Date>;
  };
  'shreni.acceptance_checks': {
    id: Generated<string>;
    project_id: string;
    task_id: string | null;
    plan_id: string | null;
    given: string;
    when: string;
    then: string;
    mode: 'auto' | 'manual';
    locked_paths: Defaulted<string[]>;
    locked_hashes: Defaulted<Record<string, string>>;
    created_at: Defaulted<Date>;
  };
  'shreni.attempt_evidence': {
    attempt_id: string;
    diff_ref: string | null;
    pr_url: string | null;
    /** Gate results by gate; `acceptance` is what checksPassed reads. */
    gates: Defaulted<AttemptGates>;
    /** One entry per review round, oldest first. */
    rounds: Defaulted<Array<{ round: number; verdict: string } & Record<string, unknown>>>;
    adversary: Defaulted<unknown[]>;
    created_at: Defaulted<Date>;
  };
  'shreni.memories': {
    project_id: string;
    key: string;
    content: string;
    created_at: Defaulted<Date>;
    updated_at: Defaulted<Date>;
  };
}
