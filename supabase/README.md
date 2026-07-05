# Shreni telemetry backend (Supabase)

The collector for the opt-in, anonymous telemetry the Shreni CLI emits
([`src/telemetry/telemetry.ts`](../src/telemetry/telemetry.ts)). See
Shreni-beads-60f / yds.5.

- **[`migrations/`](migrations)** — the `events` table (RLS on; only the service
  role writes).
- **[`functions/anonymous-usage-telemetry/`](functions/anonymous-usage-telemetry)** — a public Edge Function that
  validates + inserts events. It **never reads the client IP** and drops any event
  whose name isn't allowlisted.

> This folder is infra only: it is excluded from the npm tarball (`files`
> whitelist) and from `tsc` (`src`-only), so it never ships or affects the build.

## Deploy (founder — you create the project)

Use a **separate** Supabase project for telemetry (anonymous, publicly-writable —
keep it isolated from any product/user data).

```bash
# 1. Create the project in the Supabase dashboard, note its <project-ref>.
# 2. Install + auth the CLI.
npm install -g supabase        # or: brew install supabase/tap/supabase
supabase login

# 3. From the repo root, link and apply.
supabase link --project-ref <project-ref>
supabase db push                                   # applies migrations/
supabase functions deploy anonymous-usage-telemetry --no-verify-jwt   # public: CLI sends no auth header
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into the function
automatically — no secrets to set.

## Wire the client to it

The function URL is `https://<project-ref>.supabase.co/functions/v1/anonymous-usage-telemetry`.
Point the CLI at it either way:

- **Per machine / CI:** `export SHRENI_TELEMETRY_ENDPOINT=https://<ref>.supabase.co/functions/v1/anonymous-usage-telemetry`
- **Baked into a release:** set `TELEMETRY_ENDPOINT` in
  [`src/telemetry/telemetry.ts`](../src/telemetry/telemetry.ts) to that URL, then
  rebuild/publish. (The URL is not a secret — it's a public ingest endpoint.)

Until one is set, opted-in events stay in the local sink and nothing is collected.

## Smoke test

```bash
curl -sS -X POST "https://<ref>.supabase.co/functions/v1/anonymous-usage-telemetry" \
  -H 'content-type: application/json' \
  -d '{"name":"session_start","anonymousId":"00000000-0000-0000-0000-000000000000","version":"0.1.0","platform":"darwin","environment":"test","props":{"kshetras":1}}'
# → 204; a garbage name or bad body → 400. Then confirm the row landed:
#   select * from public.events order by received_at desc limit 5;
# (Smoke tests should send "environment":"test" so they never skew production metrics.
#  An unknown or missing environment is stored as 'production'.)
```

## The metrics (SQL)

> All metrics filter `environment = 'production'` so your own `test` runs
> (events sent with `SHRENI_TELEMETRY_ENV=test`) never skew activation/retention.

**Activation** — of installs that initialised a project, how many reached a first merge?

```sql
with firsts as (
  select anonymous_id,
         min(received_at) filter (where name = 'kshetra_init') as init_at,
         min(received_at) filter (where name = 'task_merged')  as first_merge_at
  from public.events
  where environment = 'production'
  group by anonymous_id
)
select
  count(*) filter (where init_at is not null)        as initialized,
  count(*) filter (where first_merge_at is not null) as activated,
  round(100.0 * count(*) filter (where first_merge_at is not null)
        / nullif(count(*) filter (where init_at is not null), 0), 1) as activation_pct,
  round(avg(extract(epoch from (first_merge_at - init_at)) / 3600)
        filter (where first_merge_at is not null and init_at is not null), 1) as avg_hours_to_activate
from firsts;
```

**7-day retention** — of installs first seen, how many came back on a later day within a week?

```sql
with seen as (
  select anonymous_id,
         min(received_at)::date as first_day,
         array_agg(distinct received_at::date) as active_days
  from public.events
  where environment = 'production'
  group by anonymous_id
)
select
  count(*) as installs,
  count(*) filter (
    where exists (select 1 from unnest(active_days) d
                  where d > first_day and d <= first_day + 7)
  ) as retained_7d,
  round(100.0 * count(*) filter (
    where exists (select 1 from unnest(active_days) d
                  where d > first_day and d <= first_day + 7)
  ) / nullif(count(*), 0), 1) as retention_7d_pct
from seen;
```

## Optional hardening (later)

- **Shared write-token** to filter casual noise (it's public, not real auth):
  requires a small client change to send a header in `deliver()`.
- **Rate limiting** at the edge / a Postgres unique-ish dedupe if replay noise appears.