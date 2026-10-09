import { sql, type Kysely } from 'kysely';
import type { ShreniMigration } from './index';

// Shreni's tables (policy spec, "Shreni's tables"), beside the engine's in
// their own schema, so Shreni's writes can join the engine's transactions.
// The engine never reads them. Each row hangs off an engine row with
// on delete cascade, so a project purge takes Shreni's rows with it.

const TABLES = ['projects', 'intents', 'acceptance_checks', 'attempt_evidence', 'memories'];

const STATEMENTS = [
  sql`create schema if not exists shreni`,

  // The version fence, as the engine's (policy spec, "Schema migrations in
  // practice"): the schema's version, and the oldest Shreni that may still
  // write after it. Every Shreni write sets shreni.writer_version; a raw
  // client sets none.
  sql`create table shreni.schema_meta (
    only_row   boolean primary key default true check (only_row),
    version    int     not null,
    min_writer int     not null
  )`,
  sql`create or replace function shreni.check_writer() returns trigger
    language plpgsql as $$
    declare
      writer text := nullif(current_setting('shreni.writer_version', true), '');
      floor  int;
    begin
      if writer is not null then
        select min_writer into floor from shreni.schema_meta;
        if writer::int < floor then
          raise exception 'shreni writer version % is older than the schema''s min_writer %; upgrade Shreni', writer, floor
            using errcode = 'SH001';
        end if;
      end if;
      return coalesce(NEW, OLD);
    end
    $$`,

  // Shreni's details for each project: the engine knows nothing about repos or workers.
  sql`create table shreni.projects (
    project_id uuid        primary key references taskgraph.projects(id) on delete cascade,
    mode       text        not null check (mode in ('kshetra', 'tracker')),
    repo_url   text,
    team       text,
    created_at timestamptz not null default now()
  )`,

  // The developer's statement and intent-level checks, one per plan.
  sql`create table shreni.intents (
    project_id uuid        not null,
    plan_id    text        not null,
    statement  text        not null,
    created_at timestamptz not null default now(),
    primary key (project_id, plan_id),
    foreign key (project_id, plan_id) references taskgraph.plans(project_id, id) on delete cascade
  )`,

  // Given/when/then checks for a task, or for an intent (its plan), with their
  // mode and, once locked, the test paths and hashes that implement them.
  sql`create table shreni.acceptance_checks (
    id           uuid        primary key default gen_random_uuid(),
    project_id   uuid        not null,
    task_id      text,
    plan_id      text,
    given        text        not null,
    "when"       text        not null,
    "then"       text        not null,
    mode         text        not null check (mode in ('auto', 'manual')),
    locked_paths text[]      not null default '{}',
    locked_hashes jsonb      not null default '{}',
    created_at   timestamptz not null default now(),
    check ((task_id is null) <> (plan_id is null)),
    foreign key (project_id, task_id) references taskgraph.tasks(project_id, id) on delete cascade,
    foreign key (project_id, plan_id) references shreni.intents(project_id, plan_id) on delete cascade
  )`,
  sql`create index acceptance_checks_task on shreni.acceptance_checks (project_id, task_id)`,
  sql`create index acceptance_checks_plan on shreni.acceptance_checks (project_id, plan_id)`,

  // What one attempt produced and how it was judged: one attempt is a whole
  // Silpi <-> Viharapala loop, so its review rounds are kept in order. The
  // project is the attempt's.
  sql`create table shreni.attempt_evidence (
    attempt_id uuid        primary key references taskgraph.attempts(id) on delete cascade,
    diff_ref   text,
    pr_url     text,
    gates      jsonb       not null default '{}',
    rounds     jsonb       not null default '[]',   -- [{ round, verdict, feedback… }], oldest first
    adversary  jsonb       not null default '[]',
    created_at timestamptz not null default now()
  )`,

  // Project insights: what bd remember kept.
  sql`create table shreni.memories (
    project_id uuid        not null references taskgraph.projects(id) on delete cascade,
    key        text        not null,
    content    text        not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (project_id, key)
  )`,

  ...TABLES.map(t => sql`create trigger ${sql.raw(`${t}_writer`)} before insert or update or delete on ${sql.table(`shreni.${t}`)}
    for each row execute function shreni.check_writer()`),
];

export const migration: ShreniMigration = {
  version: 1,
  name: '0001_tables',
  async up(db: Kysely<any>) {
    for (const statement of STATEMENTS) await statement.execute(db);
  },
};
