import { sql, type Kysely } from 'kysely';
import type { EngineMigration } from './index';

// The backstops (engine spec, "Build vs. reuse" and "Invariants"): the engine
// checks every rule in its transactions, and these triggers refuse a write
// that breaks one from any client, raw SQL included.
//
// SQLSTATE TG001 is a version mismatch, which the engine raises as
// VersionMismatch; TG002 is any other refused write.

const STATEMENTS = [
  // The version fence, shared by every engine table. Versions are set by every
  // engine write; a raw client sets none and is held to the rules only.
  sql`create or replace function taskgraph.check_writer(project uuid) returns void
    language plpgsql as $$
    declare
      engine     text := nullif(current_setting('taskgraph.engine_version', true), '');
      lc_name    text := nullif(current_setting('taskgraph.lifecycle_name', true), '');
      lc_version text := nullif(current_setting('taskgraph.lifecycle_version', true), '');
      floor      int;
      p          record;
    begin
      if engine is not null then
        select min_writer into floor from taskgraph.schema_meta;
        if engine::int < floor then
          raise exception 'engine version % is older than the schema''s min_writer %', engine, floor
            using errcode = 'TG001';
        end if;
      end if;
      if lc_name is not null then
        select lifecycle_name, lifecycle_version into p from taskgraph.projects where id = project;
        if found and (lc_name <> p.lifecycle_name or lc_version::int <> p.lifecycle_version) then
          raise exception 'this process runs lifecycle %@%, but project % is on %@%',
            lc_name, lc_version, project, p.lifecycle_name, p.lifecycle_version
            using errcode = 'TG001';
        end if;
      end if;
    end
    $$`,

  sql`create or replace function taskgraph.check_engine_write() returns trigger
    language plpgsql as $$
    begin
      if TG_OP = 'DELETE' then
        perform taskgraph.check_writer(OLD.project_id);
        return OLD;
      end if;
      perform taskgraph.check_writer(NEW.project_id);
      return NEW;
    end
    $$`,

  ...['plans', 'task_deps', 'task_links', 'attempts'].map(table => sql`
    create trigger ${sql.raw(`${table}_writer`)} before insert or update or delete on ${sql.table(`taskgraph.${table}`)}
      for each row execute function taskgraph.check_engine_write()`),

  // Before the append-only trigger, which refuses updates and deletes anyway.
  sql`create trigger events_writer before insert on taskgraph.events
    for each row execute function taskgraph.check_engine_write()`,

  // The task rules. The import and purge settings are plain session settings:
  // the triggers stop mistakes from any client, not a client with the
  // database's credentials set on getting past them, which could as well drop
  // the trigger.
  sql`create or replace function taskgraph.check_task_write() returns trigger
    language plpgsql as $$
    declare
      project    uuid := case when TG_OP = 'DELETE' then OLD.project_id else NEW.project_id end;
      importing  boolean := TG_OP = 'INSERT' and nullif(current_setting('taskgraph.importing', true), '') = project::text;
      purging    boolean := TG_OP = 'DELETE' and nullif(current_setting('taskgraph.purging', true), '') = project::text;
      lc_name    text;
      lc_version int;
      def        jsonb;
      leased     text;
    begin
      perform taskgraph.check_writer(project);
      if TG_OP = 'UPDATE' and NEW.state is not distinct from OLD.state
         and NEW.lease_attempt_id is not distinct from OLD.lease_attempt_id then
        return NEW; -- no rule below can change its verdict
      end if;
      if coalesce(purging, false) then
        return OLD;
      end if;

      select d.definition, pr.lifecycle_name, pr.lifecycle_version into def, lc_name, lc_version
        from taskgraph.projects pr
        join taskgraph.lifecycles d on d.name = pr.lifecycle_name and d.version = pr.lifecycle_version
       where pr.id = project;

      if TG_OP = 'DELETE' then
        if OLD.state <> def->'create'->>'state' then
          raise exception 'can''t delete task % in %: only a task still in % is deleted', OLD.id, OLD.state, def->'create'->>'state'
            using errcode = 'TG002';
        end if;
        return OLD;
      end if;

      if not (def->'states' ? NEW.state) then
        raise exception '% is not a state of lifecycle %@%', NEW.state, lc_name, lc_version
          using errcode = 'TG002';
      end if;

      if TG_OP = 'INSERT' then
        if not coalesce(importing, false) and NEW.state <> def->'create'->>'state' and not exists (
             select 1 from jsonb_each_text(coalesce(def->'create'->'byRole', '{}'::jsonb)) b where b.value = NEW.state) then
          raise exception 'a new task can''t start in %: the create rules say %', NEW.state, def->'create'->>'state'
            using errcode = 'TG002';
        end if;
      elsif NEW.state is distinct from OLD.state then
        if not exists (
             select 1 from jsonb_array_elements(def->'moves') m
              where m->>'to' = NEW.state and m->'from' ? OLD.state) then
          raise exception 'no move goes from % to % in lifecycle %@%', OLD.state, NEW.state, lc_name, lc_version
            using errcode = 'TG002';
        end if;
      end if;

      if NEW.lease_attempt_id is not null then
        select key into leased from jsonb_each(def->'states') where value ? 'leased';
        if NEW.state is distinct from leased then
          raise exception 'a lease is only held in the leased state %, not %', leased, NEW.state
            using errcode = 'TG002';
        end if;
      end if;
      return NEW;
    end
    $$`,

  sql`create trigger tasks_check before insert or update or delete on taskgraph.tasks
    for each row execute function taskgraph.check_task_write()`,

  // Events are the history of record. Only projects.purge deletes them, and
  // only the purged project's, named in taskgraph.purging.
  sql`create or replace function taskgraph.events_append_only() returns trigger
    language plpgsql as $$
    begin
      if TG_OP = 'DELETE' and OLD.project_id::text = nullif(current_setting('taskgraph.purging', true), '') then
        return OLD;
      end if;
      raise exception 'taskgraph.events is append-only' using errcode = 'TG002';
    end
    $$`,

  sql`create trigger events_append_only before update or delete on taskgraph.events
    for each row execute function taskgraph.events_append_only()`,

  sql`create trigger events_no_truncate before truncate on taskgraph.events
    for each statement execute function taskgraph.events_append_only()`,
];

export const migration: EngineMigration = {
  version: 2,
  name: '0002_triggers',
  async up(db: Kysely<any>) {
    for (const statement of STATEMENTS) await statement.execute(db);
  },
};
