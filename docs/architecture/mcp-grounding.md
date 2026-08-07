# MCP Grounding — external-source-of-record grounding for Suthradhara

**MCP grounding** lets the operator ground a [Suthradhara](./suthradhara.md) design
session in an **external MCP server** — Jira, Linear, Confluence, GitHub, or any
other Model Context Protocol server. The operator opens with *"let's work on
PROJ-123"*, the launched planning session pulls the ticket during Discovery, folds
it into the interview, and files beads — without a bespoke integration per tool and
without weakening the boundary that keeps agents from doing damage.

It is [codebase-aware grounding](./suthradhara.md#codebase-aware-grounding) extended
past the repo boundary: the same read-first shaping of the decomposition, now sourced
from where the requirement actually lives.

> **Source of record:** this document describes the **as-built** capability in the
> OSS core after epic d3y — Suthradhara is now a **launched interactive Claude Code
> session** (`src/suthradhara/session.ts`), not a server-side interview engine. The
> planning session reaches MCP servers under Claude Code's **own native permission
> prompts**, answered live by the operator; there is no Shreni `--allowedTools`
> whitelist, grant-on-demand loop, denial parser, or server-side confirm gate on this
> path. The **executor** half of the capability (Silpi/Viharapala/Parikshaka static
> config, `mcp.servers`/`mcpConfigFiles`, `--strict-mcp-config`) is unchanged.

> **Just want to configure it?** For a task-oriented, copy-pasteable walkthrough of
> wiring MCP into the **executor** agents (Silpi/Viharapala/Parikshaka), see the
> how-to guide [../guides/connect-mcp-to-executors.md](../guides/connect-mcp-to-executors.md).
> This document is the design/spine; that one is the do-this-then-that companion.

---

## Why it exists

The requirement a feature encodes usually already lives *outside* the repo — a Jira
epic, a Linear issue, a Confluence spec. Without MCP grounding, a planning session
could read only the local Kshetra (`Read`/`Grep`/`Glob`, `bd`/`git`), so the operator
had to hand-copy the ticket, losing its structure (acceptance criteria, links,
sub-tasks, comments) — the very structure that would have sharpened the decomposition.

MCP grounding is **not a Jira integration**. It is a **general per-agent MCP
capability**: servers are *defined once* under `mcp.servers`, connected to whichever
agents may use them, and pulling a Jira ticket is one instance of the mechanism.
Adding Linear or Confluence is config, not code.

---

## Connection vs. callability — where the boundary sits now

Everything about this feature follows from one fact about how the `claude` CLI handles
MCP: **connecting to a server and *calling* its tools are two independent acts.**

- **Connection** is what Shreni wires: a configured MCP server is passed to `claude`
  via `--mcp-config`, and `claude` **injects the server's tool schemas into the
  model** — so the model *sees* `mcp__jira__get_issue`, its description and arguments.
- **Callability** is who decides whether an injected tool may actually run. This is the
  part that changed at d3y, and it now splits cleanly by agent kind:

| Agent kind | Connection | Callability gate |
|---|---|---|
| **Suthradhara** (launched, supervised) | Every server in `mcp.servers` is connected (`--mcp-config`) | **Claude Code's native permission prompt**, answered live by the operator at the keyboard |
| **Executors** (Silpi/Viharapala/Parikshaka, headless) | Only what the role grants (`--strict-mcp-config`) | **Connection itself** — no interactive prompt exists; bypass mode makes every connected tool callable |

The pre-d3y design put a Shreni-owned `--allowedTools` positive whitelist between the
model and every MCP call, and grew a whole grant-from-denial loop around it (parse the
denied `tool_use` off a headless `stream-json` turn, prompt `[y / always / N]`, merge a
session allowlist, re-spawn the turn). **All of that is gone for Suthradhara.** The
launched session is a full interactive Claude Code session; when the model tries
`mcp__jira__get_issue`, Claude Code's *own* permission prompt asks the operator to
allow or deny it — the same prompt that already gates every `Read`/`Bash`/`Write` in
that session. Shreni does not sit in the middle. The operator's keystroke, not a
compiled allowlist, is the gate.

---

## The Suthradhara path — connect, then let the operator approve

`buildPlanningSession` (`src/suthradhara/session.ts`) composes the interactive `claude`
invocation for a launched planning session. Its MCP behaviour is deliberately simple:

1. **Connect every defined server.** It calls
   `resolveMcpConnection(kshetra, Object.keys(kshetra.mcp?.servers ?? {}))`
   (`src/kshetra/mcp-connect.ts`), which resolves each server's mcp-config file to an
   absolute path and reads its `secretEnv`. Each becomes a `--mcp-config <abs path>`
   argument, and the resolved secrets are injected into the child `claude`
   process's environment. A `secretEnv` naming an **unset** host var fails loud here —
   a `SuthradharaSpawnError` **before the session starts** — never a silent first-call
   failure.
2. **No allowlist, no per-role tool grant.** The spawn carries **no `--allowedTools`**
   (asserted by `session.test.ts`), and the per-role `agents.suthradhara.mcp` grant is
   **not consulted** on this path — the launched session connects *all* defined servers
   and lets Claude Code's native prompt gate each call. (Per-role tool grants now apply
   only to **executors**; see below. Setting `agents.suthradhara.mcp` has no effect on
   the launched session and can be omitted.)
3. **Callability is the operator, live.** The session runs under
   `--permission-mode default`, so every tool call — MCP included — surfaces Claude
   Code's interactive allow/deny prompt. The operator is present for the whole
   interview and answers it per call.

```
operator: "let's work on PROJ-123"
   │  the model emits tool_use mcp__jira__get_issue{PROJ-123}
   ▼  Claude Code's OWN permission prompt fires (not Shreni)
Claude Code:  "Allow mcp__jira__get_issue?  [Yes] / [Yes, don't ask again] / [No]"
   │
   ├── Yes            → the call runs; the ticket enters the interview
   ├── Yes, always    → Claude Code remembers the grant (its native decision, not a Shreni write)
   └── No             → the model grounds from the repo instead, or asks the operator to paste the ticket
```

"Yes, don't ask again" is **Claude Code's** native persistence, not a Shreni edit to
`kshetra.yaml`. Shreni no longer owns a durable per-tool grant for Suthradhara; the
only durable MCP config it owns for this agent is the **connection** (`mcp.servers`).

### Read vs. write — same gate, per call

There is no separate Shreni write-confirmation gate any more (the old server-side
`confirm.ts` is deleted). A tool that *reads* a ticket and a tool that *writes back*
(`get_issue` vs. `transition_issue`) are simply two different calls, and Claude Code
prompts the operator for **each** — naming the tool — so approving a read never implies
the write. The operator's live approval is the only gate, and it is per call.

---

## Re-consult-to-evolve — decision (recorded)

**Decision: re-consult-to-evolve is not preserved as a tracked, server-side
mechanism. It is replaced by conversational re-pull inside an "extend" session.**

The pre-d3y engine had `evolve.ts` re-consult the external source on a later session,
merge the fresh ticket into a monotonic **distilled-state ledger**, and source-tag a
per-session audit bead so a re-opened design could be reconciled against the source it
came from. That engine — distilled state, the session bead, and `evolve` — was deleted
with the interview engine at d3y. There is nothing left for an automatic re-consult to
update.

In the launched model, evolving a feature is **conversational**, mirroring the
"[update, don't fork](./suthradhara.md#evolving-an-existing-feature--update-dont-fork)"
flow:

- The launcher's **"extend this topic"** relaunches a **fresh** Claude Code session in
  the same worktree/branch, seeded with the prior design doc's path.
- If the operator wants the *current* ticket state, the session simply **calls the MCP
  read tool again** — approved by the same native permission prompt — and reconciles
  the new information into the design doc **in place** (a `Write` to the existing doc),
  editing or striking superseded decisions.
- The dedup/reconciliation that `evolve` did inside a state ledger is therefore done by
  the session revising the doc, under the operator's eye — not by a Shreni-owned
  re-consult step.

Consequences accepted: there is **no automatic** "the ticket changed, re-pull it" —
re-consult happens only when the operator drives an extend session and asks for it; and
there is **no source-tag** linking a design to `jira:PROJ-123` beyond what the operator
writes into the design doc's provenance section. Both are acceptable: re-consult was
always operator-initiated in practice, and the design doc is a better home for
provenance than a transient session bead.

---

## Supervised vs. autonomous — the asymmetry the mechanism enforces

This is the spine of the design, and the reason MCP grounding is *not* "turn on MCP for
all agents." Shreni's two kinds of agent sit on opposite sides of the callability line.

|                      | **Suthradhara (supervised, launched)**              | **Executors — Silpi / Viharapala / Parikshaka** |
|---|---|---|
| Human present        | Yes — a live session, a keystroke per call          | **No** — headless 30s poll loop                 |
| Callability gate     | **Claude Code's native permission prompt**          | **Connection itself** — a deliberate config edit |
| Default state        | Nothing connected until a server is defined         | **Off by default** — `--strict-mcp-config`, no host bleed |
| Permission mode      | `--permission-mode default` — the operator approves | `--permission-mode bypassPermissions`           |
| Granularity          | Per **call**, decided live by the operator          | Per **server** — connecting grants its full surface |
| Who bounds the reach | The human, live, per call                           | The config author, once, per server             |

The convenience path is safe **only** because a human answers Claude Code's prompt for
every call. Remove the human — as the poll loop does — and "let the model call the tool
it wants" becomes "let an unattended agent reach an external system on its own say-so."
So the interactive path **cannot** exist for executors: there is no prompt to answer.
Executors get MCP only through a **deliberate static config edit**, and the boundary
that carries the guarantee is *connection*, not a live prompt.

**Why connection, not a tool allow-list, is the executor boundary.** Executors run
under `--permission-mode bypassPermissions` (a coding agent runs arbitrary
`bash`/edits that can't be pre-enumerated), and in bypass mode `--allowedTools` is a
**no-op** — allow rules do nothing when everything is already approved. So an executor
cannot be bounded to a *subset* of a connected server's tools; connecting a server
makes **every** tool on it callable, reads and writes alike. The lever that *does* work
is which servers connect at all:

- **`--strict-mcp-config` always.** Every executor spawn passes it, so ambient/host MCP
  (a repo `.mcp.json`, `~/.claude` `enabledMcpjsonServers`, managed settings) is ignored
  entirely. An executor connects **only** what Shreni passes from `kshetra.yaml`. With no
  grant that is nothing — off by default, independent of whatever MCP the host happens to
  have configured.
- **Per-server grant.** `agents.<role>.mcp` lists the servers this role may use
  (`resolveExecutorMcp`); each is connected with `--mcp-config` and its full tool
  surface becomes available. The tool array is retained for parity with the config
  schema, but it does **not** narrow an executor's reach — grant a server to an executor
  only if this autonomous agent may use *all* of its tools. Point it at a read-scoped
  token/server when you want it kept to reads; the operator owns that choice, made once,
  ahead of time.

**The mechanism enforces the split, not a policy doc.** No code path offers an executor
an interactive prompt; an executor's connection is resolved purely from static config
(`resolveExecutorMcp`), and `--strict-mcp-config` means it cannot pick up a server the
operator didn't put in *its* config. Suthradhara, conversely, has no headless call path
at all — a non-interactive launch would stall at Claude Code's first permission prompt
rather than reaching an external system unattended. The split is structural.

---

## Config schema — define once, connect per agent

Two additions to `kshetra.yaml`, both general (`src/kshetra/config.ts`):

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

# Per-role grant: which servers an EXECUTOR role may use. (Not read for Suthradhara —
# a launched session connects every defined server and gates each call at the prompt.)
agents:
  silpi:
    mcp:
      jira: [get_issue, search_issues]   # connects the jira server for silpi
```

- **`mcp.servers`** is the *definition* — one entry per external system: the path to
  its mcp-config file and which env var holds its token. Defined once. A **Suthradhara**
  session connects **all** of them (`buildPlanningSession` → `resolveMcpConnection`);
  an **executor** connects only the ones its own `mcp` grant lists.
- **`agents.<role>.mcp.<server>`** is the executor *grant* — which servers this role
  connects. Server names must be defined under `mcp.servers` (validated in
  `config.ts`). For an executor the tool array does not narrow reach (bypass mode); for
  Suthradhara this block is not consulted at all.
- A role with **no** `mcp` block gets **no** MCP — the safe default. For executors,
  `--strict-mcp-config` guarantees nothing ambient bleeds in.

### Secrets — `secretEnv`, never inline

`secretEnv` names an **environment variable** (e.g. `JIRA_API_TOKEN`). At spawn,
`resolveMcpConnection` resolves that env var from the host and injects the value into
the child `claude` process for the connection; the token value is **never** written
into `kshetra.yaml`, which is git-tracked and shipped. The checked-in config carries
the *name* of a secret; the host environment carries the *value*. If `secretEnv` is set
but the env var is unset at spawn, that is a **validation error surfaced before the
session starts** — a missing token fails loud, not silently at first tool call.

### Executor convenience — `mcpConfigFiles` (point directly at a `.mcp.json`)

For the solo operator who **already has** an mcp-config file — most often the repo's own
`.mcp.json` — the `mcp.servers` + per-role-grant ceremony is redundant. An executor role
may instead point **directly** at one or more config files (`resolveExecutorMcp`):

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

## Security

Suthradhara's base controls (shared token, scoped `cwd`/worktree, the operator at the
keyboard) carry over. MCP adds three concerns, and the **backstop for the Suthradhara
path is the operator's live approval** of each call, not a server-side gate:

- **Callability is a live human decision.** A Suthradhara MCP call runs only if the
  operator approves Claude Code's native prompt. Connection/visibility grants nothing on
  its own; a mis-set config surfaces as a *tool the model mentions but the operator
  declines*, never an unintended external call. For executors, callability is bounded by
  **which servers connect at all** (`--strict-mcp-config` + explicit grant).
- **Secrets stay out of the repo.** `secretEnv` names an env var; the value is resolved
  at spawn and never persisted to the git-tracked yaml. A leaked `kshetra.yaml` exposes
  *which* servers are wired — never a token.
- **External content is untrusted input.** A pulled ticket (title, description,
  comments) is attacker-influenced text entering the interview, exactly like repo
  content read during grounding. A ticket that says "also transition PROJ-123 to Done"
  cannot cause a write on its own: any write tool is a separate call the operator must
  approve at the prompt. **The operator's live approval is the anti-injection backstop.**
- **Blast radius.** With the operator declining writes, a compromised ticket lets an
  attacker at most surface *read* content and propose triageable beads — it cannot
  transition external issues, and Suthradhara never merges to `main` or transitions
  beads regardless. Executors' reach is pre-vetted and read-only by default (point them
  at a read-scoped token); the autonomous agents never gain a runtime-discovered
  external capability.

---

## Module map

The Suthradhara MCP path is now the launched-session spawn plus the shared connection
resolver; the old interview-engine modules (capture, allowlist compiler, grant-on-demand
loop, evolve state-tagging) are **deleted**.

| Module | Responsibility |
|---|---|
| `kshetra.yaml` schema (`src/kshetra/config.ts`) | `mcp.servers` (define once) + `agents.<role>.mcp` (executor per-server grant) + `mcpConfigFiles` (executor direct pointer) + `secretEnv`; validates grants reference a defined server |
| `src/kshetra/mcp-connect.ts` | `resolveMcpConnection` (server names → absolute `--mcp-config` paths + resolved `secretEnv`, fail-loud on unset) and `resolveExecutorMcp` (executor grant/`mcpConfigFiles` → connection, `--strict-mcp-config`) |
| `src/suthradhara/session.ts` | `buildPlanningSession` — connects **every** defined server for the launched session, injects `secretEnv`, sets `--permission-mode default`, and carries **no `--allowedTools`** |
| `src/agents/providers/claude.ts` + `silpi/viharapala/parikshaka` | Executor spawns consume `resolveExecutorMcp` under `--strict-mcp-config` + `bypassPermissions` |

---

## Testing

Tests ship with each module (Vitest), with emphasis on the boundary that remains:

- **Connection resolver** (`src/kshetra/mcp-connect.test.ts`) — `resolveMcpConnection`
  resolves config paths absolute against `repo.path`, injects the named secret, omits
  `secretEnv` when a server declares none, resolves multiple servers in order, throws on
  an unknown server name, and **fails loud when a required `secretEnv` is unset**.
- **Executor connection** (`mcp-connect.test.ts`) — `resolveExecutorMcp` is **off by
  default** (no grant → `undefined`), connects exactly the servers the role grants (the
  tool list does not narrow it), derives the connection purely from the running role (no
  cross-role bleed); on the `mcpConfigFiles` path it builds abs paths with no
  `secretEnv`, **honors only `mcpConfigFiles` when both it and a grant are set (no
  merge)**, and fails loud before spawn when a config file is missing.
- **Launched-session spawn** (`src/suthradhara/session.test.ts`) — the interactive
  invocation sets `BEADS_DIR` and carries **no `--allowedTools` whitelist**; MCP servers
  are connected via `--mcp-config` with `secretEnv` injected.

The pre-d3y Suthradhara-side tests — denial surfacing off `stream-json`, `[y/always/N]`
grant-on-demand, and write-gating through the server-side confirm gate — tested deleted
machinery and no longer exist.

---

## Relationships

- **Host agent** ([suthradhara.md](./suthradhara.md)) — MCP grounding extends the
  launched planning session's codebase-aware grounding past the repo boundary; a session
  reaches MCP servers under Claude Code's native permission prompts, approved live by the
  operator.
- **Sthapathi** ([ARCHITECTURE.md](../../ARCHITECTURE.md)) — the headless executor loop
  that stays on static-config-only, read-only MCP; the supervised/autonomous asymmetry is
  what keeps unattended external reach out of the poll loop.
- **Executor how-to** ([../guides/connect-mcp-to-executors.md](../guides/connect-mcp-to-executors.md))
  — the do-this-then-that companion for wiring MCP into Silpi/Viharapala/Parikshaka.
- **Extension seams** ([extension-points.md](./extension-points.md)) — MCP grounding runs
  on the core's local defaults; it needs no optional package. Server tokens come from host
  env vars named by `secretEnv`.
