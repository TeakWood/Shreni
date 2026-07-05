-- Shreni telemetry events (yds.5 / Shreni-beads-60f).
--
-- This table holds ONLY anonymous, opt-in events emitted by the Shreni CLI. It
-- must never contain a personal identifier: no IP address, no repo name, no file
-- path, no task content, no user identity. The only per-install key is a random
-- anonymous UUID minted client-side. Keep it that way — the CLI's consent copy
-- promises exactly this.

create table if not exists public.events (
  id           bigint generated always as identity primary key,
  received_at  timestamptz not null default now(),  -- server receipt time
  name         text        not null,                -- allowlisted event name
  anonymous_id uuid        not null,                -- random per-install id (NOT identity)
  version      text,                                -- shreni version
  platform     text,                                -- coarse OS (process.platform)
  props        jsonb                                -- small, non-identifying primitives
);

-- Query paths: retention/activation funnels group by anonymous_id + name over time.
create index if not exists events_anon_name_time_idx
  on public.events (anonymous_id, name, received_at);
create index if not exists events_name_time_idx
  on public.events (name, received_at);

-- Lock it down: RLS on, and NO policies for anon/authenticated. That means the
-- public API keys can neither read nor write this table — only the service role
-- (used exclusively by the `ingest` Edge Function, server-side) can insert. The
-- ingest endpoint is the single sanctioned write path.
alter table public.events enable row level security;

comment on table public.events is
  'Anonymous, opt-in Shreni telemetry. No PII ever. Writes only via the ingest Edge Function (service role).';