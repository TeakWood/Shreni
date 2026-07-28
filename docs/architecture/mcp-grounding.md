# MCP Grounding — external-source-of-record grounding for Suthradhara

**MCP grounding** lets the operator ground a [Suthradhara](./suthradhara.md) design
session in an **external MCP server** — Jira, Linear, Confluence, GitHub, or any
other Model Context Protocol server. The operator opens with *"let's work on
PROJ-123"*, Suthradhara pulls the ticket during Discovery, folds it into the
interview, and files beads — without a bespoke integration per tool and without
weakening the boundary that keeps agents from doing damage.

It is [codebase-aware grounding](./suthradhara.md#codebase-aware-grounding) extended
past the repo boundary: the same read-first shaping of the decomposition, now sourced
from where the requirement actually lives.

> **Source of record:** the full design rationale, alternatives, and open decisions
> live in the ARD (`Shreni-ARD-MCP-Grounding.md`, in the Shreni-cloud repo). This
> document describes the **as-built** capability in the OSS core (`src/suthradhara/`
> + the config schema). Section markers (§3.1, §4.2, …) refer to that ARD.

> **Just want to configure it?** For a task-oriented, copy-pasteable walkthrough of
> wiring MCP into the **executor** agents (Silpi/Viharapala/Parikshaka), see the
> how-to guide [../guides/connect-mcp-to-executors.md](../guides/connect-mcp-to-executors.md).
> This document is the design/spine; that one is the do-this-then-that companion.

---

## Why it exists

The requirement a feature encodes usually already lives *outside* the repo — a Jira
epic, a Linear issue, a Confluence spec. Before MCP grounding, Suthradhara could read
only the local Kshetra (`Read`/`Grep`/`Glob`, read-only `bd`/`git`), so the operator
had to hand-copy the ticket, losing its structure (acceptance criteria, links,
sub-tasks, comments) — the very structure that would have sharpened the decomposition.

MCP grounding is **not a Jira integration**. It is a **general per-agent MCP
capability**: servers are *defined once*, tools are *granted per role*, and pulling a
Jira ticket is one instance of the mechanism. Adding Linear or Confluence is config,
not code.

---

## The connection / callability split

Everything about this feature follows from one fact about how the `claude` CLI handles
MCP: **connecting to a server and *calling* its tools are two independent acts, and
Shreni controls only the second.**

- **Connection is ambient (the CLI owns it).** With a project MCP server configured,
  `claude` auto-connects it and **injects the server's tool schemas into the model** —
  so the model *sees* `mcp__jira__get_issue`, its description and arguments, **whether
  or not it may call it.** Visibility rides on connection; Shreni cannot suppress it.
- **Callability is the gate (Shreni owns it).** `--allowedTools` is a **positive
  whitelist** — the same load-bearing control already used for `bd`/`git`. An MCP tool
  is invocable only if its exact id (`mcp__<server>__<tool>`) is on that list. A tool
  the operator has not granted is **visible but not callable**.

The payoff: because a seen-but-ungranted tool is **denied rather than invisible**, the
model can surface *what it wants* by trying it — and a denial is a signal Shreni can
react to. Anchoring the boundary at *callability* (not visibility) means a mis-set
config surfaces as "the model mentioned a tool it couldn't use," never "the model
called an external system we didn't intend."

### Discovery is lazy grant-from-denial — not config parsing

Shreni does **not** parse `.claude/.mcp.json` or `~/.claude.json` to enumerate tools.
Doing so would reimplement the CLI's multi-scope config resolution, couple Shreni to
the undocumented shape of `~/.claude.json`, and *still* only yield a list of tools —
not *which one this turn needs*.

Instead, the model (seeing the injected schema) attempts
`mcp__jira__get_issue{PROJ-123}`; it is not on the allowlist, so the CLI denies it, and
the **denied `tool_use` rides the turn's `stream-json` output** — the same stream
`capture.ts` already parses for the assistant reply. Suthradhara surfaces that denial
and asks the operator about *exactly* the tool the session wants, read-only if the
grounding only reads. Communicate through the signal already on the wire; don't
reimplement someone else's resolution logic.

---

## Interactive grant-on-demand — `[y / always / N]`

The operator never has to pre-configure which MCP tools a session may call. The model
asks by trying; Suthradhara asks the operator; on assent the grant is added and the
turn re-runs.

```
operator: "let's work on PROJ-123"
   │  model emits tool_use mcp__jira__get_issue{PROJ-123}
   ▼  not on --allowedTools → CLI denies → denial rides stream-json (capture.ts)
Suthradhara:  "The session wants to call  mcp__jira__get_issue.  Allow it?
                 [y] this session   [always] persist to kshetra.yaml   [N] deny"
   │
   ├── y      → add mcp__jira__get_issue to the SESSION allowlist        → re-spawn the turn
   ├── always → same, AND persist agents.suthradhara.mcp.jira.tools+=get_issue
   │            to .shreni/kshetra.yaml                                   → re-spawn the turn
   └── N      → no grant; the model continues without the tool           → turn proceeds
```

- **`y` — session grant.** The tool id joins the in-memory session allowlist for the
  rest of the session; the turn is **re-spawned** so the now-allowed call succeeds.
  Nothing is written to disk.
- **`always` — persist.** In addition, the per-role grant is written to
  `agents.suthradhara.mcp.<server>.tools` in `.shreni/kshetra.yaml`, so next session it
  is granted from the start. This is the **only** way config gains an MCP grant: as the
  durable form of an interactive `always` — never a mandatory upfront edit.
- **`N` — deny.** No grant, no re-spawn; the model is told the tool is unavailable and
  grounds from the repo instead, or asks the operator to paste the ticket.

**Re-spawn, not resume.** Each Suthradhara turn is already a fresh stateless `claude`
invocation driven by [distilled state](./suthradhara.md#distilled-state-is-the-conversation-summary),
so "re-run the turn with one more allowed tool" is a natural, cheap operation — no
special resume machinery.

### Read by default, write only on explicit opt-in

A grant is **read-only unless the operator explicitly opts into write.** The
`[y/always/N]` prompt **names the tool**, so `get_issue` and `transition_issue` are
distinct grants — granting a read never implies the write. A tool that mutates the
external system additionally routes through Suthradhara's
[server-side confirm gate](./suthradhara.md#confirmation--commit) (the same gate that
governs filing a bead or writing the design doc): reading a ticket does not touch the
confirm gate; writing back to Jira does.

---

## Supervised vs. autonomous — the asymmetry the mechanism enforces

This is the spine of the design, and the reason MCP grounding is *not* "turn on MCP for
all agents." Shreni's two kinds of agent sit on opposite sides of the grant line.

|                      | **Suthradhara (supervised)**                        | **Executors — Silpi / Viharapala / Parikshaka** |
|---|---|---|
| Human present        | Yes — a REPL, a keystroke per grant                 | **No** — headless 30s poll loop                 |
| Grant path           | **Interactive grant-on-demand** `[y/always/N]`      | **Static config only** — a deliberate edit      |
| Default state        | Nothing granted; discover per session               | **Off by default** — `--strict-mcp-config`, no host bleed |
| Permission mode      | `--permission-mode default` — allow-list gates      | `--permission-mode bypassPermissions`           |
| Granularity          | Per **tool** — allow-list is the callability gate   | Per **server** — connecting grants its full surface |
| Who bounds the reach | The human, live, per tool                           | The config author, once, per server             |

The convenience path is safe **only** because a human keystroke gates every grant and
the confirm gate governs every write. Remove the human — as the poll loop does — and
"grant the tool the model asked for" becomes "let an unattended agent reach an external
system on its own say-so." So the interactive path **cannot** exist for executors:
there is no `[y/always/N]` to answer. Executors get MCP only through a **deliberate
static config edit**, and the boundary that carries the guarantee is *connection*, not a
tool allow-list.

**Why connection, not the allow-list, is the executor boundary.** Executors run under
`--permission-mode bypassPermissions` (a coding agent runs arbitrary `bash`/edits that
can't be pre-enumerated), and in bypass mode `--allowedTools` is a **no-op** — allow
rules do nothing when everything is already approved. So an executor cannot be bounded to
a *subset* of a connected server's tools the way Suthradhara is; connecting a server
makes **every** tool on it callable, reads and writes alike. The lever that *does* work
is which servers connect at all:

- **`--strict-mcp-config` always.** Every executor spawn passes it, so ambient/host MCP
  (a repo `.mcp.json`, `~/.claude` `enabledMcpjsonServers`, managed settings) is ignored
  entirely. An executor connects **only** what Shreni passes from `kshetra.yaml`. With no
  grant that is nothing — off by default, independent of whatever MCP the host happens to
  have configured.
- **Per-server grant.** `agents.<role>.mcp` lists the servers this role may use; each is
  connected with `--mcp-config` and its full tool surface becomes available. The tool
  array is retained for parity with Suthradhara's schema, but it does **not** narrow an
  executor's reach — grant a server to an executor only if this autonomous agent may use
  *all* of its tools. Point it at a read-scoped token/server when you want it kept to
  reads; the operator owns that choice, made once, ahead of time.

**The mechanism enforces the split, not a policy doc.** No code path offers an executor an
interactive grant; an executor's connection is resolved purely from static config with no
session-grant merge (the grant-on-demand loop is wired only into Suthradhara's REPL). An
executor *cannot* drift into grant-on-demand, and `--strict-mcp-config` means it cannot
pick up a server the operator didn't put in *its* config. The split is structural — the
same supervised/autonomous line that keeps Suthradhara filing work interactively and
executors transitioning it headlessly, extended to a new capability.

---

## Config schema — define once, grant per role

Two additions to `kshetra.yaml`, both general:

```yaml
# Servers DEFINED once, at the Kshetra level: a connection + how to auth it.
# `config` is a repo-relative path to an mcp-config file (the `.mcp.json` shape
# `claude --mcp-config` consumes); the connection details (command/args or url)
# live there, keeping kshetra.yaml free of transport detail.
mcp:
  servers:
    jira:
      config: .shreni/mcp/jira.json    # repo-relative mcp-config file
      secretEnv: JIRA_API_TOKEN        # NAME of an env var — never the value
    linear:
      config: .shreni/mcp/linear.json
      secretEnv: LINEAR_API_KEY

# Tools GRANTED per role: the callability whitelist, per agent.
agents:
  suthradhara:
    mcp:
      jira: [get_issue, search_issues]   # → mcp__jira__get_issue, mcp__jira__search_issues
```

- **`mcp.servers`** is the *definition* — one entry per external system: the path to
  its mcp-config file and which env var holds its token. Defined once; referenced by
  any role. At spawn (`buildClaudeSpawn`) each server is connected with
  `--mcp-config <abs path>`, `--strict-mcp-config` is deliberately **not** passed (so an
  ambient project `.mcp.json` also connects), and `secretEnv` is resolved from the host
  env into the child process — an unset var is a **fail-loud error before the session
  starts** (`SuthradharaSpawnError`), never a silent first-call failure.
- **`agents.<role>.mcp.<server>`** is the *grant* — the exact tool names the role may
  call. The allowlist compiler (pmb.5) expands `{jira: [get_issue]}` into the exact id
  `mcp__jira__get_issue`. **No wildcard is representable.**
- A role with **no** `mcp` block gets **no** MCP callability — the safe default.
  Connection may still be ambient, but nothing is callable.

> **Version assumptions — validated (claude 2.1.212, pmb.4).** Two CLI behaviors the
> lazy-grant path leans on were confirmed by spike: (1) `--setting-sources project`
> (and `--mcp-config`) **connect** a project server — the server reports
> `status: connected` and its tools appear in the injected schema — without
> `--strict-mcp-config` suppressing an ambient `.mcp.json`; (2) a `tool_use` for an
> ungranted MCP tool is **denied cleanly**: the turn's `result` stays
> `is_error: false` and the denial rides `permission_denials[]` as
> `{tool_name, tool_use_id, tool_input}` — exactly the shape `capture.ts` reads. Only
> the individual `tool_result` block carries the deny; the turn itself succeeds. Re-run
> the spike if these regress on a CLI upgrade.

This is deliberately parallel to how `bd`/`git` grants already work: a positive,
enumerated, per-agent whitelist. MCP is not a new *kind* of boundary — it is the same
boundary extended to a new class of tool id.

### Secrets — `secretEnv`, never inline

`secretEnv` names an **environment variable** (e.g. `JIRA_API_TOKEN`). At spawn, the
wiring resolves that env var from the host and injects the value into the child
`claude` process for the connection; the token value is **never** written into
`kshetra.yaml`, which is git-tracked and shipped. The checked-in config carries the
*name* of a secret; the host environment carries the *value*. If `secretEnv` is set but
the env var is unset at spawn, that is a **validation error surfaced before the session
starts** — a missing token fails loud, not silently at first tool call.

### Executor convenience — `mcpConfigFiles` (point directly at a `.mcp.json`)

For the solo operator who **already has** an mcp-config file — most often the repo's own
`.mcp.json` — the `mcp.servers` + per-role-grant ceremony is redundant. An executor role
may instead point **directly** at one or more config files:

```yaml
agents:
  silpi:
    # repo-relative mcp-config (.mcp.json-shaped) files. Resolved absolute against
    # repo.path and passed one-per-file via --mcp-config. --strict-mcp-config stays ON.
    mcpConfigFiles:
      - .mcp.json
```

- **Why not just drop `--strict-mcp-config`?** Because in headless `-p` mode a repo-root
  `.mcp.json` needs a workspace-trust approval that has **no TTY to answer** — an untrusted
  ambient server is **silently skipped** (not an error, not a hang), so the agent runs
  without tools it was expected to have, and *whether* it connects depends on invisible
  host state (`~/.claude` trust records). Passing the file **explicitly** via
  `--mcp-config` bypasses the trust gate and connects deterministically on every machine.
  So `--strict-mcp-config` stays **on**; this is just an explicit per-role pointer.
- **Mutually exclusive with the role's `mcp` grant.** Only **one** method is honored per
  role. When both are set, **`mcpConfigFiles` wins** and the grant is **ignored** for that
  role (a `console.warn` marks it). The two are **not merged** — merging is deliberately
  **deferred** pending developer feedback.
- **No `secretEnv` indirection on this path.** Any secret the config file references must
  **already be present** in the environment Shreni runs under; there is no env-var-name
  resolution as on the `mcp.servers` path. (The `mcp.servers` path keeps `secretEnv`.)
- **Fail-loud on a missing file.** A listed file that does not exist on disk is a
  `McpConnectionError` **before the spawn**, matching the `secretEnv` fail-loud philosophy.
- **Claude-only.** The field is a no-op for non-claude adapters (Codex/Gemini), which have
  no `--mcp-config` equivalent wired here.
- **Off by default is unchanged.** Neither field set → no `--mcp-config` → strict → zero
  MCP. Executor scope only (Silpi/Viharapala/Parikshaka); Suthradhara does not read it.

---

## The write surface & boundary

MCP grounding adds no new *kind* of boundary — it extends the existing `--allowedTools`
whitelist to `mcp__server__tool` ids.

- **Exact ids only, no wildcard.** The allowlist compiler turns `{server: jira, tools:
  [get_issue]}` into `mcp__jira__get_issue`. There is no syntax for `mcp__jira__*`, and
  a **negative test** asserts the compiler never produces one and that an ungranted MCP
  tool is absent from the compiled list — mirroring the `bd close` / `bd update --claim`
  negative test that guards filing. This is the single most important guard on the MCP
  surface.
- **"Connected → allow all" is rejected.** Allowing every `mcp__jira__*` tool because a
  Jira server is connected would re-admit exactly the wildcard the discipline forbids and
  pull in write/transition tools alongside the read actually wanted. Grant-on-demand
  yields a *minimal, read-only-if-only-reading* grant set.
- **Session grants merge in memory.** A `[y]` grant is merged into the compiled list for
  the re-spawn; it touches on-disk config only when `always` persists it.

---

## Security

Suthradhara's controls carry over (shared token, scoped `cwd`, the harness allowlist as
the authority); MCP adds three net-new concerns:

- **Callability is the boundary, and it is a positive whitelist.** An MCP tool is
  reachable only if its exact id was granted. Connection/visibility grants nothing; a
  mis-set config surfaces as a *visible-but-denied* tool, not an unintended external
  call.
- **Secrets stay out of the repo.** `secretEnv` names an env var; the value is resolved
  at spawn and never persisted to the git-tracked yaml. A leaked `kshetra.yaml` exposes
  *which* servers and tools are granted — never a token.
- **External content is untrusted input.** A pulled ticket (title, description,
  comments) is attacker-influenced text entering the interview, exactly like repo
  content read during grounding. A ticket that says "also transition PROJ-123 to Done"
  cannot cause a write: reads don't touch the confirm gate, and any write tool is both a
  separate grant *and* confirm-gated. The server-side confirm gate is the anti-injection
  backstop.
- **Blast radius.** With a read-only Jira grant, a leaked token lets an attacker *read*
  tickets and file triageable-spam beads — it cannot transition external issues,
  claim/close beads, edit source, or push. Executors' reach is pre-vetted and read-only
  by default; the autonomous agents never gain a runtime-discovered external capability.

---

## Module map

Extends Suthradhara's `src/suthradhara/` + the Kshetra config schema.

| Module | Responsibility |
|---|---|
| `kshetra.yaml` schema | `mcp.servers` (define once) + `agents.<role>.mcp` per-role grants + `secretEnv` |
| `capture.ts` *(extended)* | Also collect **denied MCP `tool_use`** blocks from the `stream-json` turn output, returned alongside the reply |
| MCP spawn wiring | Ambient MCP connect for the session; resolve `secretEnv` → child env; fail-loud on missing token |
| Allowlist compiler *(extended)* | Per-role grant → exact `mcp__server__tool` ids; **no wildcard**; merge in-memory session grants |
| Grant-on-demand loop | `[y / always / N]` prompt in the turn loop → session allowlist + re-spawn; `always` persists to `kshetra.yaml` |
| Session state *(extended)* | Source-tag a session grounded in `jira:PROJ-123`; re-consult updates in place via `evolve` |

---

## Testing

Tests ship with each module (Vitest), with emphasis on the boundary:

- **Allowlist compiler (negative test)** — a per-role grant compiles to exact
  `mcp__server__tool` ids; **no wildcard** is ever produced, and an ungranted MCP tool
  is absent from the compiled list. The single most important guard.
- **Denial surfacing** — a turn whose model emits an ungranted MCP `tool_use` returns
  that denied block from `capture.ts` so the turn loop can prompt.
- **Grant-on-demand** — `y` adds the tool to the session allowlist and re-spawns; `always`
  additionally persists the grant to `kshetra.yaml`; `N` grants nothing and does not
  re-spawn.
- **Secret hygiene** — `secretEnv` resolves from the host env at spawn and never appears
  in `kshetra.yaml`; a missing env var is a pre-start validation error, not a silent
  first-call failure.
- **Supervised/autonomous split** — an executor role's allowlist compiles purely from
  static config with **no** interactive/session-grant path; no code offers an executor a
  grant prompt.
- **Write gating** — an MCP write tool routes through the confirm gate; a read does not.

---

## Relationships

- **Host agent** ([suthradhara.md](./suthradhara.md)) — MCP grounding extends
  Suthradhara's codebase-aware grounding past the repo boundary, reusing its turn loop,
  confirm gate, and allowlist discipline wholesale.
- **Sthapathi** ([ARCHITECTURE.md](../../ARCHITECTURE.md)) — the headless executor loop
  that stays on static-config-only, read-only MCP; the supervised/autonomous asymmetry is
  what keeps runtime grant-on-demand out of the poll loop.
- **Extension seams** ([extension-points.md](./extension-points.md)) — MCP grounding runs
  on the core's local defaults; it needs no optional package. Server tokens come from host
  env vars named by `secretEnv`.
