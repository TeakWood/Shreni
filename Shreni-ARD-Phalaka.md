# ARD — Phalaka (Task Dashboard)

> **Architecture Requirements Document**
> Feature: per-Kshetra task dashboard served by an independent webserver
> Status: **Draft / proposed**
> Date: 2026-06-29
> Related: [Shreni-PRD.md](Shreni-PRD.md), [Shreni-TDD.md](Shreni-TDD.md)

---

## 1. Context

Shreni manages multiple independent projects (**Kshetras**), each with its own
[beads](https://github.com/) (`bd`) task database. Today the only ways to see task
state are the `shreni status` CLI and the **Vichara** chat PWA. Neither gives a
fast, scannable, per-project **list of all tasks** with drill-down into a single
task's details.

This ARD proposes **Phalaka** (Sanskrit *फलक* — "panel / board / slate"), a
read-mostly web dashboard that:

- lists every registered Kshetra,
- shows all of that Kshetra's tasks (beads) as a list view,
- lets a task be clicked to expand its full details inline,
- runs as its **own independent webserver process**, started automatically when
  Shreni starts.

> **Naming:** `phalaka` follows the existing Sanskrit-role convention (`kshetra`,
> `sthapathi`, `vichara`, `silpi`, `parikshaka`, `viharapala`). Alternatives
> considered: `darpana` (mirror), `darshana` (viewing). **Phalaka** is preferred
> because a dashboard *is* a board. This is the one decision worth a quick
> confirmation before code starts — everything else below is internal.

---

## 2. Goals / Non-Goals

### Goals
- **G1** — One screen listing all Kshetras and, per Kshetra, all tasks as a list.
- **G2** — Click a task → expand its full details (description, status, priority,
  assignee, dependencies, notes, timestamps) without leaving the list.
- **G3** — Run as an **independent webserver**, isolated from the agent workers and
  from Vichara, so a dashboard crash never touches orchestration.
- **G4** — **Auto-start with Shreni** (`shreni start`), with an opt-out, mirroring
  how a long-running service should behave.
- **G5** — Reuse existing infrastructure (Fastify, PID tracking, token auth,
  registry, beads read access) rather than introducing new patterns.

### Non-Goals (MVP)
- **NG1** — No task *mutation* from the dashboard (no claim/close/create/edit).
  Read-only view only; the PRD makes Sthapathi the sole owner of the `bd`
  write lifecycle. Write actions are a deferred phase (see §11).
- **NG2** — No new build pipeline / bundler / framework. Single-file frontend,
  same as Vichara's `pwa.ts`.
- **NG3** — No auth provider, multi-user, or remote-exposure hardening beyond the
  existing localhost + shared-token model.
- **NG4** — No historical analytics, burndown charts, or cross-project rollups.

---

## 3. Precedent: Vichara (what we copy)

Phalaka deliberately mirrors the **Vichara** server so it slots into existing
conventions. Key reference points:

| Concern | Vichara implementation | Phalaka reuse |
|---|---|---|
| HTTP server | Fastify ([src/vichara/server.ts](src/vichara/server.ts)) | same |
| Process model | detached `spawn`, `child.unref()`, log to `~/.shreni/*.log` ([src/cli/vichara.ts](src/cli/vichara.ts)) | same |
| PID tracking | `~/.shreni/vichara.pid` ([src/vichara/pid.ts](src/vichara/pid.ts)) | new `phalaka.pid` |
| Auth | shared token in `~/.shreni`, `?token=` ([src/vichara/token.ts](src/vichara/token.ts)) | **same token file** |
| Frontend | single inlined HTML string ([src/vichara/pwa.ts](src/vichara/pwa.ts)) | same approach |
| Bind | `0.0.0.0`, default port `7347` | `127.0.0.1`, default port `7348` |
| Launcher script | `cli/vichara-server.ts` entry → spawned | new `cli/phalaka-server.ts` |

> **Divergence:** Phalaka binds **`127.0.0.1`** (loopback only), not `0.0.0.0`.
> The dashboard exposes task content across *all* projects and has no per-request
> need for LAN access (Vichara's `0.0.0.0` exists for phone access). Loopback is
> the safer default; LAN exposure can be a flag later.

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  shreni start                                                │
│    ├─ startWorker(kshetra) … per Kshetra (existing)          │
│    └─ startPhalaka()  ← NEW, auto-start (opt-out via flag)    │
└─────────────────────────────────────────────────────────────┘
                              │ detached spawn
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  phalaka-server (independent process, port 7348)             │
│                                                              │
│  Fastify                                                     │
│   GET /                 → single-file dashboard HTML         │
│   GET /api/kshetras     → [{id,name, taskCounts}]            │
│   GET /api/kshetras/:id/tasks         → task list (summary)  │
│   GET /api/kshetras/:id/tasks/:beadId → one task (full)      │
│         (all /api/* require ?token= or Bearer token)         │
│                                                              │
│  Data layer (read-only):                                     │
│   loadRegistry()  ──────────────► ~/.shreni/registry.json    │
│   beadsRead(kshetra).list()  ──► `bd list --json`  (per Ks)  │
│   beadsRead(kshetra).show(id) ─► `bd show <id> --json`       │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Process isolation (G3)
Phalaka is a **separate OS process**, spawned detached and `unref`'d exactly like
the Vichara server and the Kshetra workers. It shares no memory with orchestration.
It only reads `~/.shreni/registry.json` and shells out to `bd` read commands. A
Phalaka crash is invisible to Sthapathi and the agents.

### 4.2 Data source (read-only beads access)
Tasks are sourced from each Kshetra's beads DB. The existing `bd()` wrapper in
[src/sthapathi/beads.ts](src/sthapathi/beads.ts) is documented *"Internal-only…
never called by agents or Vichara directly."* Rather than weaken that contract,
introduce a small **read-only accessor** (`src/phalaka/beads-read.ts`) that runs
only non-mutating commands (`list --json`, `show --json`) with
`BEADS_DIR=kshetra.beads.path` — the same pattern `shreni status` already relies
on. No `--claim`, `--close`, or `create` paths exist in Phalaka.

> **Why a separate reader, not reuse `bd()`:** keeps the "Sthapathi owns writes"
> invariant textually enforceable (the mutation methods simply don't exist in
> Phalaka's surface), and lets the reader add list-view concerns (sorting,
> light caching) without touching the orchestration wrapper.

### 4.3 Caching
`bd` invocations are subprocess calls. To keep the list view responsive and avoid
hammering `bd` on every poll, the reader caches each Kshetra's `list --json` result
for a short TTL (default **5s**). `show` (full detail) is fetched on demand when a
task is expanded and cached per-bead for the same TTL. Cache is in-process and
per-Kshetra-keyed.

---

## 5. HTTP API

All `/api/*` routes require the shared token (`?token=` query or
`Authorization: Bearer <token>`), validated against `readToken()`. `GET /`
serves the HTML shell unauthenticated (it contains no data; the page reads the
token from the URL and attaches it to API calls), matching Vichara.

| Method | Route | Returns |
|---|---|---|
| `GET` | `/` | Dashboard HTML (single file) |
| `GET` | `/api/kshetras` | `[{ id, name, counts: {open, in_progress, blocked, closed} }]` |
| `GET` | `/api/kshetras/:id/tasks` | `[{ id, title, status, priority, type, assignee, updatedAt }]` |
| `GET` | `/api/kshetras/:id/tasks/:beadId` | Full bead: above + `description, notes, design, acceptance, dependencies, blockedBy, createdAt` |
| `GET` | `/api/health` | `{ ok: true, version }` (no auth) |

- Unknown Kshetra id → `404`.
- `bd` failure for one Kshetra → that Kshetra's entry carries an `error` field;
  the rest of the dashboard still renders (one project's broken beads DB must not
  blank the whole board).
- Responses are typed and validated with `zod` (already a dependency), reusing
  the bead shape where possible.

### 5.1 Update model
MVP uses **client polling** (`GET /api/kshetras/:id/tasks` on a ~10s interval, and
the Kshetra summary on focus). This is simpler than WebSockets for a read-mostly
board and is bounded by the 5s server cache. WebSocket push (reusing the
`@fastify/websocket` dep already present) is a deferred enhancement if live
updates are wanted.

---

## 6. Frontend

A **single self-contained HTML document** (inlined as a TS string in
`src/phalaka/ui.ts`, mirroring `src/vichara/pwa.ts`) — no bundler, no framework
dependency, vanilla JS + minimal CSS. Layout:

- **Left rail / header:** list of Kshetras with task counts; selecting one filters
  the main panel. (MVP can render all Kshetras stacked as collapsible sections.)
- **Main panel:** task **list view** for the selected Kshetra — one row per task
  showing id, title, status badge, priority, assignee.
- **Drill-down (G2):** clicking a row **expands the row inline** (accordion) and
  lazy-loads `GET …/tasks/:beadId` to show full details. One expanded row at a
  time; collapse on re-click.
- Status/priority rendered as color-coded badges; sortable/filterable by status
  and priority client-side.
- Reads `token` from `location.search`, attaches it to every `fetch`.

> Frontend design intentionally minimal for MVP; if a richer visual treatment is
> wanted, the `frontend-design` skill can guide typography/layout in a later pass.

---

## 7. Process lifecycle & CLI

Mirror the Vichara command surface and add auto-start.

### 7.1 New module `src/phalaka/`
```
src/phalaka/
  server.ts        # createPhalakaServer(port) / startPhalakaServer(port)
  ui.ts            # INDEX_HTML single-file frontend
  beads-read.ts    # read-only bd accessor (list/show), TTL cache
  pid.ts           # read/write/clear ~/.shreni/phalaka.pid, isAlive (reuse shape)
  api.ts           # route handlers + zod response schemas
src/cli/
  phalaka.ts        # startPhalaka()/stopPhalaka()/statusPhalaka() (spawn mgmt)
  phalaka-server.ts # spawned entry: writePid, ensureToken, startPhalakaServer
```
`token.ts` is **shared** with Vichara (same `~/.shreni` token), so no new token
module. `pid.ts` follows `src/vichara/pid.ts` with a `phalaka.pid` path.

### 7.2 CLI commands (in `src/cli/index.ts`)
```
shreni phalaka start [--port <n>]
shreni phalaka stop
shreni phalaka status
```
Identical UX to the existing `vichara` subcommand block.

### 7.3 Auto-start on `shreni start` (G4)
Extend the `start` case so that after starting Kshetra workers it also calls
`startPhalaka()` (idempotent — returns `already_running` if a live PID exists),
printing the dashboard URL. Add `--no-dashboard` to opt out, and honor a
`PHALAKA_DISABLE=1` env var for headless/CI runs. `shreni stop` (no `--kshetra`)
also stops Phalaka.

> Decision: auto-start is **on** by default to satisfy "run as an independent
> webserver when Shreni starts." It is opt-out, not opt-in, because the whole
> point is that the operator gets the board for free.

---

## 8. Configuration

| Setting | Source | Default |
|---|---|---|
| Port | `PHALAKA_PORT` env / `--port` | `7348` |
| Bind host | constant | `127.0.0.1` |
| List cache TTL | constant (later configurable) | `5s` |
| Poll interval (client) | constant | `10s` |
| Token | `~/.shreni` token (shared) | generated via `ensureToken()` |
| Log file | constant | `~/.shreni/phalaka.log` |
| Auto-start | `--no-dashboard` / `PHALAKA_DISABLE` | enabled |

---

## 9. Security

- **Loopback only** (`127.0.0.1`) — not reachable off-host by default.
- **Token-gated API** — every `/api/*` data route checks the shared `~/.shreni`
  token; mismatched/absent token → `401`.
- **Read-only** — Phalaka has no code path that mutates beads or the repo, so a
  token leak exposes task *visibility*, not task *control*.
- **No secrets in responses** — bead payloads are task metadata; confirm `bd show
  --json` output carries nothing sensitive before serving verbatim.
- Path params (`:id`, `:beadId`) are validated (Kshetra id must exist in registry;
  bead id format-checked) before being passed to `bd`, preventing arg injection.

---

## 10. Testing

Per project rule, tests ship with the feature (Vitest, `*.test.ts`):

- **beads-read.ts** — parses `bd list/show --json`; TTL cache hit/miss; per-Kshetra
  error isolation (one failing `bd` doesn't throw the whole list). `bd` mocked.
- **api.ts / server.ts** — Fastify `inject()` tests: 401 without token, 200 with,
  404 unknown Kshetra, shape validation against zod schemas, partial-failure
  response includes `error` field.
- **cli/phalaka.ts** — start returns `already_running` on live PID; stop clears
  stale PID; spawn args/env (`PHALAKA_PORT`) correct (spawn mocked, as in existing
  CLI tests).
- **Auto-start wiring** — `shreni start` invokes `startPhalaka` and respects
  `--no-dashboard` / `PHALAKA_DISABLE`.
- Tests isolate `HOME` to a temp dir (existing pattern — see recent commit
  `00f5b08`) so they never touch real `~/.shreni`.

---

## 11. Phasing

| Phase | Scope |
|---|---|
| **P0 (MVP)** | `src/phalaka/` server + read-only API + single-file list/drill-down UI; `shreni phalaka` CLI; auto-start on `shreni start`; tests. |
| **P1** | WebSocket live updates (reuse `@fastify/websocket`); client filtering/sorting polish; per-Kshetra error surfacing in UI. |
| **P2** | Optional write actions (file a task, pause/resume a Kshetra) — must route through Sthapathi-owned paths, not direct `bd` writes, to preserve the PRD invariant. |
| **P3** | Optional LAN exposure flag + richer visual design pass. |

---

## 12. Alternatives Considered

1. **Add dashboard routes to the Vichara server** (no new process). *Rejected* —
   violates G3 (isolation): a dashboard bug could take down the chat interface,
   and the two have different bind/exposure needs (Vichara `0.0.0.0` for phone vs
   Phalaka loopback). Separate process is cleaner and matches the "independent
   webserver" requirement explicitly.
2. **Reuse the internal `bd()` wrapper directly.** *Rejected* — it exposes mutation
   methods and is contractually "internal-only"; a dedicated read accessor keeps
   the write-ownership invariant enforceable by construction.
3. **WebSocket-first (no REST).** *Deferred* — overkill for a read-mostly board;
   polling against a 5s server cache is simpler and adequate for MVP.
4. **Build-tooling SPA (React/Vite).** *Rejected for MVP* — introduces a build
   pipeline the repo deliberately avoids (Vichara is single-file); revisit only if
   UI complexity demands it.

---

## 13. Resolved Decisions

- **D1 — Name: Phalaka.** ✅ Confirmed (over `darpana` / `darshana`).
- **D2 — Exposure: loopback-only (`127.0.0.1`).** ✅ Confirmed. LAN access remains a
  deferred flag (P3), not a day-one default.
- **D3 — Default list view: active states only** (open / in-progress / blocked),
  with closed tasks behind a filter toggle. ✅ Confirmed.

### Still open
- **Q1** Default port `7348` acceptable (Vichara is `7347`)? — assumed yes unless
  flagged.