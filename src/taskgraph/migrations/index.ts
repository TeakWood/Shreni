import type { Kysely } from 'kysely';
import { migration as core } from './0001_core';
import { migration as triggers } from './0002_triggers';

// The engine's schema migrations (engine spec, "Schema migrations"). The list is
// static: the single-file binary bundles every module, so there is no folder for
// a file-based provider to read. Append new migrations; never edit or reorder
// one that has shipped.

export interface EngineMigration {
  /** 1, 2, 3…: a process's engine version is the newest one its code carries. */
  version: number;
  /** `<version padded to 4>_<slug>`; the name recorded in taskgraph.kysely_migration. */
  name: string;
  /**
   * The oldest engine version that can still write after this migration. Set
   * only by a breaking migration; an additive one leaves min_writer alone.
   */
  minWriter?: number;
  up(db: Kysely<any>): Promise<void>;
}

export const MIGRATIONS: readonly EngineMigration[] = [core, triggers];
