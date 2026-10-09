import { Kysely, sql as raw } from 'kysely';
import type postgres from 'postgres';
import { PostgresJsDialect } from './pg-dialect';
import { migrate, pendingMigrations, type MigrationReport } from './migrate';
import { defineLifecycle, registerLifecycle, type Call, type Lifecycle } from './lifecycle';
import { checkPermission } from './permissions';
import { loadTask, tasksApi } from './tasks';
import { once as onceFor, type PriorWrite } from './requests';
import { depsApi, linksApi, notesApi } from './deps';
import { movesApi, type MoveOptions } from './moves';
import { readsApi } from './reads';
import { approveTaskApi, plansApi, type ApprovalOptions } from './plans';
import type { Validator } from './validators';
import { lockKey, Session, type Release } from './session';
import { activateApi, diffApi } from './upgrade';
import { claimApi, expireLeasesApi, leasedApi } from './claims';
import { exportProject, importProject, purgeProject, type ImportCallback, type ImportReport, type ProjectBundle, type PurgeReport } from './bundle';

type ReadsApi = ReturnType<typeof readsApi>;
import { runTransaction, type EngineTx } from './tx';
import { LeaseLost, NotFound, NotPermitted, SchemaBehind, VersionMismatch, type Finding } from './errors';
import type { Actor, Task } from './types';

// The engine's entry point (engine spec, "API"): one client per process, one
// handle per project, and every write through an actor. Client calls
// (migrate, projects) belong to whoever holds the database credentials and
// aren't role-checked.

export interface OpenTaskGraphOptions {
  /** The caller's postgres.js instance. Give this or `db`. */
  sql?: postgres.Sql;
  /**
   * A Kysely instance instead, as tests do over PGlite. Session locks then run
   * on it, so it must be a single session, as PGlite is; not a pool.
   */
  db?: Kysely<any>;
  /**
   * A postgres.js instance on a direct connection (not through a pooler),
   * with max: 1 and max_lifetime: null, for session locks and LISTEN. Needed
   * for tg.locks with `sql`. The caller owns it and ends it.
   */
  session?: postgres.Sql;
  /** The caller's validators, run after the engine's own in plans.validate and approval. */
  validators?: Validator[];
  /**
   * Each validator's config, passed to it as ctx.config: by validator name,
   * or a function of the project and the name, for configs that differ by project.
   */
  validatorConfig?: ValidatorConfig;
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

export type ValidatorConfig = Record<string, unknown> | ((projectId: string, validator: string) => unknown);

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
    /** @internal The session connection, for session locks (and LISTEN). */
    readonly session: Session = new Session(db),
    /** @internal */ readonly validators: readonly Validator[] = [],
    /** @internal */ readonly validatorConfig: ValidatorConfig = {},
  ) {}

  /** @internal Each validator's config for one project. */
  configFor(projectId: string): (name: string) => unknown {
    const c = this.validatorConfig;
    return name => (typeof c === 'function' ? c(projectId, name) : c[name]);
  }

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

    /** Every row of a project, events included, read in one snapshot; `inSnapshot` reads the caller's rows in it too. */
    export: async (id: string, inSnapshot?: Parameters<typeof exportProject>[2]): Promise<ProjectBundle> => {
      await this.need(CORE);
      if (!UUID.test(id)) throw new NotFound('project', id);
      return exportProject(this.db, id.toLowerCase(), inSnapshot);
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
    await this.session.close();
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
  readonly locks: {
    /**
     * A session advisory lock named for this project, on the client's session
     * connection: a release function, or null at once if another session holds
     * it. Held until released, or until the client or its connection closes.
     */
    trySession(name: string): Promise<Release | null>;
    /**
     * Who holds the session lock `name`: the application_name the holder's
     * session connection set (a worker names its host and pid there), '' when
     * it set none, or null when no one holds it.
     */
    holder(name: string): Promise<string | null>;
  };
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
    this.locks = {
      trySession: name => client.session.trySession(id, name),
      holder: async name => {
        await client.need('0001_core');
        const r = await raw<{ app: string | null }>`
          select a.application_name as app
            from pg_locks l join pg_stat_activity a on a.pid = l.pid
           where l.locktype = 'advisory' and l.granted
             and ((l.classid::bigint << 32) | l.objid::bigint) = ${lockKey(id, name)}::bigint
           limit 1`.execute(client.db);
        return r.rows[0] ? (r.rows[0].app ?? '') : null;
      },
    };
    this.expireLeases = expireLeasesApi(client, id);
  }

  /** The same project, acting as `actor`: every write goes through one. */
  as(actor: Actor): ActorHandle {
    return new ActorHandle(this, checkActor(actor));
  }
}

export class ActorHandle {
  readonly tasks: ReturnType<typeof tasksApi> & { approve(id: string, opts: ApprovalOptions): Promise<Task> };
  readonly deps: ReturnType<typeof depsApi>;
  readonly links: ReturnType<typeof linksApi>;
  readonly notes: ReturnType<typeof notesApi>;
  /** Makes a declared move; throws MoveRefused. */
  readonly move: (taskId: string, moveName: string, opts?: MoveOptions) => Promise<Task>;
  readonly lifecycles: ReturnType<typeof activateApi>;
  readonly plans: ReturnType<typeof plansApi>;
  /** Sweeps, then leases the next ready task to a worker; null when nothing is ready. */
  readonly claim: ReturnType<typeof claimApi>;
  /** Renews a claim's lease; throws LeaseLost once it no longer holds the task. */
  readonly heartbeat: ReturnType<typeof leasedApi>['heartbeat'];
  /** A move fenced by the claim's attempt id; throws LeaseLost or MoveRefused. */
  readonly moveClaimed: ReturnType<typeof leasedApi>['moveClaimed'];
  readonly claims: ReturnType<typeof leasedApi>['claims'];
  /** @internal move() with a fence; use moveClaimed. */
  readonly moveFenced: ReturnType<typeof movesApi>;

  /** @internal Use tg.as(actor). */
  constructor(/** @internal */ readonly project: ProjectHandle, readonly actor: Actor) {
    // In the constructor body: field initializers would run before the
    // parameter properties above are set.
    // Every write that takes a request id runs once per id (requests.ts).
    const { client, id: projectId } = project;
    const once = <T>(requestId: string | undefined, kind: string, taskId: string | undefined,
                     act: () => Promise<T>, replay: (p: PriorWrite) => Promise<T>, planId?: string) =>
      onceFor(client.db, projectId, requestId, kind, { actor: actor.id, taskId, planId }, act, replay);
    const reads = project;
    const task = (p: PriorWrite) => loadTask(client.db, projectId, p.taskId!);
    const nothing = async () => {};

    const tasks = tasksApi(this);
    const approveTask = approveTaskApi(this);
    this.tasks = {
      ...tasks,
      create: (input, opts = {}) => once(opts.requestId, 'task.created', undefined, () => tasks.create(input, opts), task),
      update: (id, patch, opts = {}) => once(opts.requestId, 'task.updated', id, () => tasks.update(id, patch, opts), task),
      delete: (id, opts = {}) => once(opts.requestId, 'task.deleted', id, () => tasks.delete(id, opts), nothing),
      /** Approves a task with no plan, after the task-scope validators; throws ValidationError. */
      approve: (id: string, opts: ApprovalOptions) =>
        once(opts?.requestId, `move:${client.lifecycle.hooks.onApprove}`, id, () => approveTask(id, opts), task),
    };
    const deps = depsApi(this);
    this.deps = {
      add: (a, b, opts = {}) => once(opts.requestId, 'dep.added', a, () => deps.add(a, b, opts), nothing),
      remove: (a, b, opts = {}) => once(opts.requestId, 'dep.removed', a, () => deps.remove(a, b, opts), nothing),
    };
    const links = linksApi(this);
    this.links = { add: (a, b, kind, opts = {}) => once(opts.requestId, 'link.added', a, () => links.add(a, b, kind, opts), nothing) };
    const notes = notesApi(this);
    this.notes = { add: (id, text, opts = {}) => once(opts.requestId, 'note', id, () => notes.add(id, text, opts), nothing) };
    const moves = movesApi(this);
    const fenced: ReturnType<typeof movesApi> = (taskId, moveName, opts = {}, fence) =>
      once(opts.requestId, `move:${moveName}`, taskId, () => moves(taskId, moveName, opts, fence), task);
    this.move = (taskId, moveName, opts) => fenced(taskId, moveName, opts);
    this.moveFenced = fenced;
    const plans = plansApi(this);
    const plan = (p: PriorWrite) => reads.plans.get(p.planId!);
    this.plans = {
      ...plans,
      create: (input, opts = {}) => once(opts.requestId, 'plan.created', undefined, () => plans.create(input, opts), plan),
      approve: (planId, opts) => once(opts?.requestId, 'plan.approved', undefined, () => plans.approve(planId, opts),
        async p => ({ ...(await plan(p)), findings: (p.payload.findings ?? []) as Finding[] }), planId),
      discard: (planId, opts) => once(opts?.requestId, 'plan.discarded', undefined, () => plans.discard(planId, opts), plan, planId),
    };
    const lifecycles = activateApi(this);
    this.lifecycles = {
      activate: (version, opts = {}) => once(opts.requestId, 'lifecycle.upgraded', undefined, () => lifecycles.activate(version, opts), nothing),
    };
    const claim = claimApi(this);
    const claimMove = client.lifecycle.moves.find(m => m.name === client.lifecycle.hooks.onClaim)!;
    this.claim = async opts => {
      // The role check runs before any replay, so a replay never hands a claim to a role that can't work.
      if (!claimMove.by.includes(actor.role)) throw new NotPermitted('claim', actor.role);
      return once(opts?.requestId, `move:${claimMove.name}`, undefined, () => claim(opts), replayClaim);
    };
    const replayClaim = async (p: PriorWrite) => {
      // The same attempt, while it still holds the task; never a second task.
      const t = await loadTask(client.db, projectId, p.taskId!);
      if (t.leaseAttemptId !== p.attemptId) throw new LeaseLost(p.taskId!, p.attemptId!);
      return { task: t, attemptId: p.attemptId!, expiresAt: t.leaseExpiresAt! };
    };
    const leased = leasedApi(this);
    this.heartbeat = leased.heartbeat;
    this.moveClaimed = leased.moveClaimed;
    this.claims = leased.claims;
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
  const client = new TaskGraphClient(db, lifecycle, owns, new Session(db, options.session, !!options.sql),
    options.validators ?? [], options.validatorConfig ?? {});
  try {
    await client.refresh();
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}
