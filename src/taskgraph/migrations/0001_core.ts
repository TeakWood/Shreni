import { sql, type Kysely } from 'kysely';
import type { EngineMigration } from './index';

// The core schema (engine spec, "Data model" and "Testing: Controlling time"):
// every engine table and index, and taskgraph.now(). The backstop triggers come
// in a later migration. One statement per query, so the migration runs on any
// driver, including those that refuse multi-statement queries.

const STATEMENTS = [
  sql`create schema if not exists taskgraph`,

  // Lease and expiry times read the database clock through this one function,
  // so workers never compare their own clocks and tests can move time.
  sql`create or replace function taskgraph.now() returns timestamptz
    language sql stable as $$
      select coalesce(nullif(current_setting('taskgraph.fake_now', true), '')::timestamptz, now())
    $$`,

  sql`create table taskgraph.schema_meta (
    only_row   boolean primary key default true check (only_row),
    version    int     not null,
    min_writer int     not null
  )`,

  sql`create table taskgraph.lifecycles (
    name          text        not null,
    version       int         not null,
    definition    jsonb       not null,
    hash          text        not null,
    registered_at timestamptz not null default now(),
    primary key (name, version)
  )`,

  sql`create table taskgraph.projects (
    id                uuid        primary key default gen_random_uuid(),
    name              text        not null,
    id_prefix         text        not null,
    lifecycle_name    text        not null,
    lifecycle_version int         not null,
    created_at        timestamptz not null default now(),
    foreign key (lifecycle_name, lifecycle_version) references taskgraph.lifecycles(name, version)
  )`,

  sql`create table taskgraph.plans (
    project_id   uuid        not null references taskgraph.projects(id),
    id           text        not null,
    title        text        not null,
    meta         jsonb       not null default '{}',
    approved_at  timestamptz,
    approved_by  text,
    discarded_at timestamptz,
    discarded_by text,
    created_at   timestamptz not null default now(),
    primary key (project_id, id),
    check (approved_at is null or discarded_at is null)
  )`,

  sql`create table taskgraph.tasks (
    project_id       uuid        not null references taskgraph.projects(id),
    id               text        not null,
    key              text,
    plan_id          text,
    parent_id        text,
    kind             text        not null check (kind in ('work','container')),
    category         text,
    title            text        not null check (length(title) <= 500),
    description      text,
    priority         smallint    not null default 2 check (priority between 0 and 4),
    state            text        not null,
    origin           text        not null check (origin in ('plan','manual','system','agent','imported')),
    spec             jsonb       not null default '{}',
    tags             text[]      not null default '{}',
    boosted          boolean     not null default false,
    hold_until       timestamptz,
    next_child       int         not null default 1,
    lease_attempt_id uuid,
    lease_expires_at timestamptz,
    search           tsvector    generated always as
                       (to_tsvector('simple'::regconfig, title || ' ' || coalesce(description, ''))) stored,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    closed_at        timestamptz,
    primary key (project_id, id),
    unique (project_id, key),
    foreign key (project_id, plan_id)   references taskgraph.plans(project_id, id),
    foreign key (project_id, parent_id) references taskgraph.tasks(project_id, id),
    check ((lease_attempt_id is null) = (lease_expires_at is null)),
    check ((origin = 'plan') = (plan_id is not null))
  )`,

  sql`create table taskgraph.task_deps (
    project_id    uuid not null,
    task_id       text not null,
    depends_on_id text not null,
    primary key (project_id, task_id, depends_on_id),
    foreign key (project_id, task_id)       references taskgraph.tasks(project_id, id) on delete cascade,
    foreign key (project_id, depends_on_id) references taskgraph.tasks(project_id, id) on delete cascade,
    check (task_id <> depends_on_id)
  )`,

  sql`create table taskgraph.task_links (
    project_id uuid not null,
    a          text not null,
    b          text not null,
    kind       text not null,
    primary key (project_id, a, b, kind),
    foreign key (project_id, a) references taskgraph.tasks(project_id, id) on delete cascade,
    foreign key (project_id, b) references taskgraph.tasks(project_id, id) on delete cascade
  )`,

  sql`create table taskgraph.attempts (
    id         uuid        primary key,
    project_id uuid        not null,
    task_id    text        not null,
    worker     text        not null,
    actor      text        not null,
    started_at timestamptz not null default now(),
    ended_at   timestamptz,
    outcome    text,
    foreign key (project_id, task_id) references taskgraph.tasks(project_id, id)
  )`,

  sql`create table taskgraph.events (
    id         bigint      generated always as identity primary key,
    project_id uuid        not null,
    task_id    text,
    plan_id    text,
    attempt_id uuid,
    kind       text        not null,
    actor      text        not null,
    actor_role text        not null,
    from_state text,
    to_state   text,
    payload    jsonb       not null default '{}',
    request_id text,
    at         timestamptz not null default now()
  )`,

  sql`create table taskgraph.purges (
    project_id uuid        not null,
    name       text        not null,
    actor      text        not null,
    counts     jsonb       not null,
    at         timestamptz not null default now()
  )`,

  // The claim and ready queries, the lease sweep, walks up and down the graph,
  // history, and request-id retries.
  sql`create index tasks_ready on taskgraph.tasks (project_id, state, boosted desc, priority, created_at) where kind = 'work'`,
  sql`create index tasks_leases on taskgraph.tasks (project_id, lease_expires_at) where lease_expires_at is not null`,
  sql`create index tasks_parent on taskgraph.tasks (project_id, parent_id)`,
  sql`create index tasks_search on taskgraph.tasks using gin (search)`,
  sql`create index deps_reverse on taskgraph.task_deps (project_id, depends_on_id)`,
  sql`create index links_reverse on taskgraph.task_links (project_id, b)`,
  sql`create index attempts_task on taskgraph.attempts (project_id, task_id, started_at)`,
  sql`create index events_project on taskgraph.events (project_id, id)`,
  sql`create index events_task on taskgraph.events (project_id, task_id, id)`,
  sql`create unique index events_request on taskgraph.events (project_id, request_id) where request_id is not null`,
];

export const migration: EngineMigration = {
  version: 1,
  name: '0001_core',
  minWriter: 1,
  async up(db: Kysely<any>) {
    for (const statement of STATEMENTS) await statement.execute(db);
  },
};
