import { Kysely, sql as raw } from 'kysely';
import type postgres from 'postgres';
import { PostgresJsDialect } from './pg-dialect';
import { migrate, pendingMigrations, type MigrationReport } from './migrate';
import { defineLifecycle, registerLifecycle, type Call, type Lifecycle } from './lifecycle';
import { checkPermission } from './permissions';
import { tasksApi } from './tasks';
import { depsApi, linksApi, notesApi } from './deps';
import { movesApi } from './moves';
import { readsApi } from './reads';
import { activateApi, diffApi } from './upgrade';
import { claimApi, expireLeasesApi } from './claims';
import { exportProject, importProject, purgeProject, type ImportCallback, type ImportReport, type ProjectBundle, type PurgeReport } from './bundle';

type ReadsApi = ReturnType<typeof readsApi>;
import { runTransaction, type EngineTx } from './tx';
import { NotFound, SchemaBehind, VersionMismatch } from './errors';
import type { Actor } from './types';

// The engine's entry point (engine spec, "API"): one client per process, one
// handle per project, and every write through an actor. Client calls
// (migrate, projects) belong to whoever holds the database credentials and
// aren't role-checked.

export interface OpenTaskGraphOptions {
  /** The caller's postgres.js instance. Give this or `db`. */
  sql?: postgres.Sql;
  /** A Kysely instance instead, as tests do over PGlite. */
  db?: Kysely<any>;
  lifecycle: Lifecycle;
}

export type Project = {
  /** A uuid, never shown to people; kept in the repo's Shreni config. */
  id: string;
  /** The readable name, such as the Kshetra id; need not be unique. */
  name: string;
  idPrefix: string;
  /** The active lifecycle. */
  lifecycleName: string;
  lifecycleVersion: number;
  createdAt: Date;
};

/** The migration every current read needs. */
const CORE = '0001_core';
/** Writes also need the backstop triggers in place. */
const TRIGGERS = '0002_triggers';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No dot: a child id is its parent's id plus .<n>.
const ID_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function checkActor(actor: Actor): Actor {
  if (!actor?.id || !actor?.role) throw new TypeError('an actor needs an id and a role');
  return actor;
}

type ProjectRow = {
  id: string; name: string; id_prefix: string; lifecycle_name: string; lifecycle_version: number; created_at: Date;
};

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    idPrefix: r.id_prefix,
    lifecycleName: r.lifecycle_name,
    lifecycleVersion: r.lifecycle_version,
    createdAt: r.created_at,
  };
}

export class TaskGraphClient {
  /** Migrations this code carries that the database lacks; refreshed by migrate(). */
  private pending: Set<string> = new Set();

  /** @internal Use openTaskGraph. */
  constructor(
    /** @internal */ readonly db: Kysely<any>,
    readonly lifecycle: Lifecycle,
    private readonly ownsDb: boolean,
  ) {}

  /** @internal Reads which migrations have run, and registers the lifecycle once the schema has it. */
  async refresh(): Promise<void> {
    const pending = new Set(await pendingMigrations(this.db));
    // Register before marking the schema current, so a failed registration
    // leaves calls refused rather than writing against an unregistered lifecycle.
    if (!pending.has(CORE)) await registerLifecycle(this.db, this.lifecycle);
    this.pending = pending;
  }

  /**
   * @internal Throws SchemaBehind unless the migration has run. The cache is
   * read again before refusing, since another process may have migrated.
   */
  async need(migration: string): Promise<void> {
    if (!this.pending.has(migration)) return;
    await this.refresh();
    if (this.pending.has(migration)) throw new SchemaBehind(migration);
  }

  /** @internal An engine transaction marked with this process's lifecycle version. */
  transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T> {
    return runTransaction(this.db, fn, { lifecycle: { name: this.lifecycle.name, version: this.lifecycle.version } });
  }

  /** Applies pending schema migrations; run only when asked. */
  async migrate(): Promise<MigrationReport> {
    const report = await migrate(this.db);
    await this.refresh();
    return report;
  }

  readonly projects = {
    /** Creates a project on the lifecycle's registered version. */
    create: async (input: { name: string; idPrefix: string; actor: Actor }): Promise<Project> => {
      await this.need(TRIGGERS);
      const actor = checkActor(input.actor);
      if (!input.name) throw new TypeError('a project needs a name');
      if (!ID_PREFIX.test(input.idPrefix)) throw new TypeError(`invalid id prefix ${JSON.stringify(input.idPrefix)}`);
      return this.transaction(async ({ db, emit }) => {
        const r = await raw<ProjectRow>`
          insert into taskgraph.projects (name, id_prefix, lifecycle_name, lifecycle_version)
          values (${input.name}, ${input.idPrefix}, ${this.lifecycle.name}, ${this.lifecycle.version})
          returning *`.execute(db);
        const project = toProject(r.rows[0]);
        emit({
          projectId: project.id, kind: 'project.created', actor: actor.id, actorRole: actor.role,
          payload: { name: project.name, idPrefix: project.idPrefix },
        });
        return project;
      });
    },

    get: async (id: string): Promise<Project> => {
      await this.need(CORE);
      if (!UUID.test(id)) throw new NotFound('project', id);
      const r = await raw<ProjectRow>`select * from taskgraph.projects where id = ${id}`.execute(this.db);
      if (!r.rows[0]) throw new NotFound('project', id);
      return toProject(r.rows[0]);
    },

    /**
     * Creates a project from a bundle and loads it in one transaction; `inTx`
     * runs inside it, so the caller's own rows land with the project or not at all.
     */
    import: async (bundle: ProjectBundle, opts: { actor: Actor; name?: string; idPrefix?: string }, inTx?: ImportCallback): Promise<ImportReport> => {
      await this.need(TRIGGERS);
      return importProject(this, bundle, { ...opts, actor: checkActor(opts.actor) }, inTx);
    },

    /** Every row of a project, events included, read in one snapshot. */
    export: async (id: string): Promise<ProjectBundle> => {
      await this.need(CORE);
      if (!UUID.test(id)) throw new NotFound('project', id);
      return exportProject(this.db, id.toLowerCase());
    },

    /** Deletes every row of a project, events included, once its name is typed back; the only delete of events. */
    purge: async (id: string, opts: { actor: Actor; confirmName: string }): Promise<PurgeReport> => {
      await this.need(TRIGGERS);
      if (!UUID.test(id)) throw new NotFound('project', id);
      return purgeProject(this.db, id.toLowerCase(), { ...opts, actor: checkActor(opts.actor) });
    },

    /** Every project in the database, oldest first. */
    list: async (): Promise<Project[]> => {
      await this.need(CORE);
      const r = await raw<ProjectRow>`select * from taskgraph.projects order by created_at, id`.execute(this.db);
      return r.rows.map(toProject);
    },
  };

  /** A handle for one project, by the uuid in the repo's Shreni config. */
  project(id: string): ProjectHandle {
    if (!UUID.test(id)) throw new NotFound('project', id);
    return new ProjectHandle(this, id.toLowerCase());
  }

  /** Releases the client. A postgres.js instance passed in stays open; its owner ends it. */
  async close(): Promise<void> {
    if (this.ownsDb) await this.db.destroy();
  }
}

export class ProjectHandle {
  readonly tasks: ReadsApi['tasks'];
  readonly plans: ReadsApi['plans'];
  readonly attempts: ReadsApi['attempts'];
  readonly events: ReadsApi['events'];
  /** Ready work, in claim order: what a claim would pick next. */
  readonly ready: ReadsApi['ready'];
  readonly lifecycles: ReturnType<typeof diffApi>;
  /** The lease sweep on its own, as system; claim runs it first. Returns how many leases it returned. */
  readonly expireLeases: ReturnType<typeof expireLeasesApi>;

  /** @internal Use client.project(id). */
  constructor(/** @internal */ readonly client: TaskGraphClient, readonly id: string) {
    // In the constructor body, as in ActorHandle.
    const reads = readsApi(this);
    this.tasks = reads.tasks;
    this.plans = reads.plans;
    this.attempts = reads.attempts;
    this.events = reads.events;
    this.ready = reads.ready;
    this.lifecycles = diffApi(this);
    this.expireLeases = expireLeasesApi(client, id);
  }

  /** The same project, acting as `actor`: every write goes through one. */
  as(actor: Actor): ActorHandle {
    return new ActorHandle(this, checkActor(actor));
  }
}

export class ActorHandle {
  readonly tasks: ReturnType<typeof tasksApi>;
  readonly deps: ReturnType<typeof depsApi>;
  readonly links: ReturnType<typeof linksApi>;
  readonly notes: ReturnType<typeof notesApi>;
  /** Makes a declared move; throws MoveRefused. */
  readonly move: ReturnType<typeof movesApi>;
  readonly lifecycles: ReturnType<typeof activateApi>;
  /** Sweeps, then leases the next ready task to a worker; null when nothing is ready. */
  readonly claim: ReturnType<typeof claimApi>;

  /** @internal Use tg.as(actor). */
  constructor(/** @internal */ readonly project: ProjectHandle, readonly actor: Actor) {
    // In the constructor body: field initializers would run before the
    // parameter properties above are set.
    this.tasks = tasksApi(this);
    this.deps = depsApi(this);
    this.links = linksApi(this);
    this.notes = notesApi(this);
    this.move = movesApi(this);
    this.lifecycles = activateApi(this);
    this.claim = claimApi(this);
  }

  /**
   * @internal Throws VersionMismatch unless the project's active lifecycle is
   * this process's. Pass the transaction the call runs in.
   */
  async assertVersion(db: Kysely<any> = this.project.client.db): Promise<void> {
    const { client, id } = this.project;
    await client.need(TRIGGERS);
    const r = await raw<{ lifecycle_name: string; lifecycle_version: number }>`
      select lifecycle_name, lifecycle_version from taskgraph.projects where id = ${id}`.execute(db);
    const project = r.rows[0];
    if (!project) throw new NotFound('project', id);
    const { name, version } = client.lifecycle;
    if (project.lifecycle_name !== name || project.lifecycle_version !== version) {
      throw new VersionMismatch(
        `project ${id} is on lifecycle ${project.lifecycle_name}@${project.lifecycle_version}; this process runs ${name}@${version}`,
      );
    }
  }

  /**
   * Throws NotPermitted unless this actor's role may make `call` on a task in
   * `state`, under the project's active lifecycle, which must be this
   * process's (VersionMismatch otherwise). Pass the transaction the call runs in.
   */
  async check(call: Call, state?: string, db: Kysely<any> = this.project.client.db): Promise<void> {
    await this.assertVersion(db);
    checkPermission(this.project.client.lifecycle, call, this.actor.role, state);
  }
}

/**
 * Opens the engine: checks the lifecycle, reads which migrations have run, and
 * registers the lifecycle once the schema has it. An unmigrated database opens,
 * so migrate() can run; other calls refuse with SchemaBehind until it has.
 */
export async function openTaskGraph(options: OpenTaskGraphOptions): Promise<TaskGraphClient> {
  if (!!options.sql === !!options.db) throw new TypeError('openTaskGraph takes exactly one of sql or db');
  const lifecycle = defineLifecycle(options.lifecycle);
  const owns = !options.db;
  const db = options.db ?? new Kysely<any>({ dialect: new PostgresJsDialect({ sql: options.sql! }) });
  const client = new TaskGraphClient(db, lifecycle, owns);
  try {
    await client.refresh();
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}
