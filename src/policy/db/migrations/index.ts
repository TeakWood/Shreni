import type { Kysely } from 'kysely';
import { migration as tables } from './0001_tables';

// Shreni's schema migrations: a static, append-only list, as the engine's is.
// Never edit or reorder one that has shipped.

export interface ShreniMigration {
  /** 1, 2, 3…: a Shreni process's writer version is the newest one its code carries. */
  version: number;
  /** `<number padded to 4>_<slug>`; the name recorded in shreni.kysely_migration. */
  name: string;
  /** The oldest writer version that can still write after it; set only by a breaking migration. */
  minWriter?: number;
  up(db: Kysely<any>): Promise<void>;
}

export const SHRENI_MIGRATIONS: readonly ShreniMigration[] = [tables];
