import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'kysely';
import type { KshetraConfig } from '../../kshetra/config';
import type { BeadStats } from '../../kshetra/snapshot';
import { checkShreniBundle, exportShreniProject, importShreniProject, snapshotShreniProject, type ShreniBundle } from '../db/bundle';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { openKshetraEngine, type KshetraEngine } from './connect';
import { takeWorkerLock, WorkerLockHeld } from './leases';

// Freeze and restore on the task graph engine (migration plan, "Beyond the bd
// wrapper"): the snapshot is the project's export, Shreni's rows included, and
// its version the project's last event id; restore is a purge, then an import.

/** The file inside a snapshot that holds the project's bundle. */
export const ENGINE_SNAPSHOT_FILE = 'engine.json';

/** What a manifest records about the engine project. */
export interface EngineSnapshotInfo {
  projectId: string;
  /** The project's last event id when it was frozen. */
  lastEventId: string | null;
  eventCount: number;
  snapshotPath: string;
}

// Shreni's own tooling, not a developer: its events mustn't read as a human acting.
const ACTOR = { id: 'shreni', role: 'system' };

/** The hash over a project's task ids that a manifest records as its beadIdHash. */
export function taskIdHash(ids: string[]): string {
  return 'sha256:' + createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

/** The bead stats a manifest carries, from the bundle: tasks for beads, memories for memories. */
export function bundleStats(b: ShreniBundle): BeadStats {
  const ids = b.engine.tasks.map(t => t.id);
  const closed = b.engine.tasks.filter(t => taskLifecycle.states[t.state]?.terminal).length;
  return {
    beadCount: ids.length,
    memoryCount: b.shreni.memories.length,
    openCount: ids.length - closed,
    closedCount: closed,
    beadIdHash: taskIdHash(ids),
  };
}

/** The bundle as written and compared: JSON, with the import's own trailing event left out. */
function normalise(b: ShreniBundle): ShreniBundle {
  const j = JSON.parse(JSON.stringify(b)) as ShreniBundle;
  j.engine.events = j.engine.events.filter(e => e.kind !== 'project.imported');
  return j;
}

/**
 * Holds the Kshetra's worker lock while `fn` runs, so no worker, on this host
 * or another, writes to the project meanwhile; `force` goes ahead without it.
 */
async function withoutWorker<T>(conn: KshetraEngine, kshetra: KshetraConfig, force: boolean, fn: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await takeWorkerLock(conn.shreni.tg.project(kshetra.project!));
  } catch (err) {
    if (!(err instanceof WorkerLockHeld) || !force) throw err;
  }
  try {
    return await fn();
  } finally {
    await release?.().catch(() => {});
  }
}

/** Writes the project's bundle into the snapshot directory; `force` freezes with a worker running. */
export async function freezeEngine(
  kshetra: KshetraConfig, outDir: string, opts: { force?: boolean } = {},
): Promise<{ info: EngineSnapshotInfo; stats: BeadStats }> {
  const conn = await openKshetraEngine(kshetra, { name: 'shreni-freeze' });
  try {
    const { bundle, lastEventId } = await withoutWorker(conn, kshetra, !!opts.force,
      () => snapshotShreniProject(conn.shreni, kshetra.project!));
    writeFileSync(join(outDir, ENGINE_SNAPSHOT_FILE), JSON.stringify(bundle), 'utf8');
    return {
      info: { projectId: kshetra.project!, lastEventId, eventCount: bundle.engine.events.length, snapshotPath: ENGINE_SNAPSHOT_FILE },
      stats: bundleStats(bundle),
    };
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Puts the snapshot's project back: archives the live one beside the other
 * archived state, purges it, and imports the snapshot. The purge and the
 * import are two transactions, so the snapshot is checked first, and a failed
 * import puts the archived project back. Returns the stats, the restored
 * project's last event id, and whether its tasks and events match the snapshot's.
 */
export async function restoreEngine(
  kshetra: KshetraConfig, fromDir: string, info: EngineSnapshotInfo, archiveDir: string,
): Promise<{ stats: BeadStats; matches: boolean; lastEventId: string | null }> {
  const path = join(fromDir, info.snapshotPath);
  if (!existsSync(path)) throw new Error(`the snapshot has no engine bundle at ${path}`);
  const frozen = JSON.parse(readFileSync(path, 'utf8')) as ShreniBundle;
  if (frozen.engine?.project?.id !== kshetra.project) {
    throw new Error(`the snapshot is of project ${frozen.engine?.project?.id}, not ${kshetra.project}`);
  }
  const conn = await openKshetraEngine(kshetra, { name: 'shreni-restore' });
  try {
    return await withoutWorker(conn, kshetra, false, async () => {
      await checkShreniBundle(conn.shreni, frozen);
      const live = await sql<{ name: string }>`select name from taskgraph.projects where id = ${kshetra.project!}`.execute(conn.shreni.db);
      let archived: ShreniBundle | undefined;
      const archivePath = join(archiveDir, ENGINE_SNAPSHOT_FILE);
      if (live.rows[0]) {
        archived = await exportShreniProject(conn.shreni, kshetra.project!);
        writeFileSync(archivePath, JSON.stringify(archived), 'utf8');
        await conn.shreni.tg.projects.purge(kshetra.project!, { actor: ACTOR, confirmName: live.rows[0].name });
      }
      try {
        await importShreniProject(conn.shreni, frozen, { actor: ACTOR });
      } catch (err) {
        const why = (err as Error).message;
        if (!archived) throw new Error(`restoring the project failed: ${why}`);
        try {
          await importShreniProject(conn.shreni, JSON.parse(JSON.stringify(archived)) as ShreniBundle, { actor: ACTOR });
        } catch (back) {
          throw new Error(
            `restoring the project failed (${why}), and so did putting the live one back (${(back as Error).message}); ` +
              `it is archived at ${archivePath}`,
          );
        }
        throw new Error(`restoring the project failed, so the live one was put back: ${why}`);
      }
      const after = await snapshotShreniProject(conn.shreni, kshetra.project!);
      return {
        stats: bundleStats(after.bundle),
        lastEventId: after.lastEventId,
        matches: JSON.stringify(normalise(after.bundle)) === JSON.stringify(normalise(frozen)),
      };
    });
  } finally {
    await conn.close().catch(() => {});
  }
}
