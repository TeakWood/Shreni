# How to connect MCP servers to Shreni executor agents

This is a task-oriented guide for developers and operators. It walks you through
giving the **headless executor agents** — **Silpi** (coder), **Viharapala**
(reviewer), and **Parikshaka** (test agent) — access to an external
[Model Context Protocol](https://modelcontextprotocol.io) server (Jira, Linear,
Confluence, GitHub, a local stdio tool, …).

> **Design vs. how-to.** The *why* — the connection/callability split, the
> supervised/autonomous asymmetry, and the security rationale — lives in
> [docs/architecture/mcp-grounding.md](../architecture/mcp-grounding.md). This
> page is the **do-this-then-that** companion. Read it to configure; read the
> architecture doc to understand the boundary you are configuring.

> **Scope.** This guide covers the **executors only**. Connecting an MCP server to
> the interactive **Suthradhara** intake agent is a different path: a launched
> Claude Code session reaches the servers defined in `mcp.servers`, and callability
> is governed by **Claude Code's native MCP permission prompts** — the operator, at
> the keyboard, approves each tool call. Everything below is about the autonomous
> agents that run headlessly in the poll loop.

---

## Before you start: the one thing to understand

Executors run under `--permission-mode bypassPermissions` (a coding agent runs
arbitrary `bash`/edits that can't be pre-enumerated). In bypass mode a per-tool
allow-list is **inert** — so **connecting a server grants its entire tool surface,
reads and writes alike.** You cannot give an executor "just the read tools" of a
connected server.

The lever that *does* work is **which servers connect at all**. Two consequences:

- **Off by default.** With no MCP config, an executor spawns with
  `--strict-mcp-config` and **zero** MCP. Nothing ambient leaks in.
- **Scope with the token, not the config.** To keep an executor read-only, point
  it at a **read-scoped token or a read-only server**. That is the boundary.

Keep this in mind while choosing a method below.

---

## Choose a method

There are two ways to wire MCP into an executor role. Pick one **per role** — they
are mutually exclusive (see [Precedence](#precedence-when-both-are-set)).

| | Method A — `mcp.servers` + grant | Method B — `mcpConfigFiles` |
|---|---|---|
| **Best when** | You want tokens managed by Shreni via env-var *names*, or share one server across several roles | You already have an `.mcp.json` (e.g. the repo's own) and want to reuse it as-is |
| **Secrets** | `secretEnv` names a host env var; resolved at spawn, never in yaml | Must **already** be in Shreni's environment; no indirection |
| **Server definition** | Defined once under `mcp.servers`, referenced by name | Lives entirely in the config file you point at |
| **Ceremony** | Two blocks: define + grant | One line: a path |

Both keep `--strict-mcp-config` **on** and are **off by default**.

---

## Method A — define once, grant per role

Use this when you want Shreni to manage the connection centrally and resolve the
token from a host environment variable by name.

### 1. Define the server(s) once

Add an `mcp.servers` block to `.shreni/kshetra.yaml`. Each entry names a
repo-relative **mcp-config file** (the `.mcp.json` shape the `claude` CLI consumes)
and, optionally, the **name** of a host env var holding its token:

```yaml
mcp:
  servers:
    jira:
      config: .shreni/mcp/jira.json     # repo-relative path to an mcp-config file
      secretEnv: JIRA_API_TOKEN         # NAME of an env var — never the value
    localdocs:
      config: .shreni/mcp/localdocs.json  # a local stdio tool needing no auth: omit secretEnv
```

The referenced file (`.shreni/mcp/jira.json`) is a standard mcp-config document:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "@some/jira-mcp-server"]
    }
  }
}
```

### 2. Grant the server to each executor role

Under `agents.<role>.mcp`, list the server. The **tool array is retained for
intent/parity but does not narrow an executor's reach** — under bypass the whole
server connects:

```yaml
agents:
  silpi:
    mcp:
      jira: [get_issue, search_issues]   # intent only; the whole jira server connects
  viharapala:
    mcp:
      jira: [get_issue]
  parikshaka:
    mcp: {}                              # no server → no MCP for this role
```

Only the roles you list get MCP. A role with no `mcp` block gets **no** MCP — the
safe default. Grants are **per role, no cross-role bleed**: granting `silpi` does
not give `viharapala` anything.

### 3. Export the token before starting Shreni

```bash
export JIRA_API_TOKEN=xxxxxxxx
shreni start
```

If `secretEnv` names a var that is **unset** at spawn, Shreni **fails loud before
the session starts** — you get a clear `MCP server "jira" requires env var
JIRA_API_TOKEN, but it is unset` rather than a silent first-call failure.

---

## Method B — point directly at an `.mcp.json` (`mcpConfigFiles`)

Use this when you **already keep an mcp-config file** — most often the repo's own
`.mcp.json` — and don't want to restate it as `mcp.servers` + a grant.

```yaml
agents:
  silpi:
    # repo-relative mcp-config (.mcp.json-shaped) files. Resolved absolute against
    # repo.path and passed one-per-file via --mcp-config.
    mcpConfigFiles: [.mcp.json]
  viharapala:
    mcpConfigFiles: [.mcp.json, .shreni/mcp/review-tools.json]
```

That's it — no `mcp.servers` block, no grant.

- **Paths are repo-relative** and resolved absolute against `repo.path`, so they do
  not depend on the inherited working directory.
- **Multiple files** are allowed; each is passed as its own `--mcp-config`.
- **No `secretEnv` indirection.** Any secret the config file references must
  **already be present** in the environment Shreni runs under. Export it yourself
  before `shreni start`.
- **Claude-only** — a no-op for Codex/Gemini adapters (see below).

### Why not just drop `--strict-mcp-config` and inherit the ambient `.mcp.json`?

Because it is silently unreliable in headless mode. In `-p` (headless) mode a
repo-root `.mcp.json` needs a **workspace-trust approval that has no TTY to
answer**. An untrusted ambient server is then **silently skipped** — not an error,
not a hang. The agent just runs without the tools it was expected to have, and
*whether* it connects depends on invisible host state (`~/.claude` trust records),
so the same Kshetra behaves differently on different machines.

Passing the file **explicitly** via `--mcp-config` (which is exactly what
`mcpConfigFiles` does) **bypasses the trust gate** and connects deterministically
on every machine. That is why `--strict-mcp-config` stays **on** and you point at
the file explicitly, rather than dropping strict mode.

---

## Precedence — when both are set

`mcpConfigFiles` and the `mcp` grant are **mutually exclusive per role**. If a role
sets **both**:

- **`mcpConfigFiles` wins.** The connection is built from the config files.
- **The `mcp` grant is ignored** for that role — a `console.warn` is emitted at
  resolve time so the override is visible in the logs:
  `[mcp] role "silpi" sets BOTH mcpConfigFiles and an mcp grant — mcpConfigFiles wins; the grant is ignored (no merge).`
- **They are not merged.** Merging the two is deliberately deferred pending
  developer feedback. Pick one method per role.

```yaml
agents:
  silpi:
    mcpConfigFiles: [.mcp.json]   # ← used
    mcp:
      jira: [get_issue]           # ← ignored (with a warn)
```

---

## Secrets — the two models

| | Where the value lives | Where the yaml carries |
|---|---|---|
| **Method A (`secretEnv`)** | A host env var, resolved & injected at spawn | Only the *name* of the env var — never the value |
| **Method B (`mcpConfigFiles`)** | Must already be in Shreni's environment | Nothing — no secret indirection on this path |

**Never inline a secret literal in `kshetra.yaml`** — it is git-tracked and
shipped. Method A names an env var; Method B relies on the ambient environment.
Either way the token value stays out of the checked-in config.

---

## Non-claude adapters

MCP wiring is **claude-only** today. If the Kshetra's provider is Codex or Gemini
(`agents.provider`), both `mcp`/`secretEnv` and `mcpConfigFiles` are **no-ops** —
the connection is resolved but never passed to a `--mcp-config`-equivalent flag,
because those adapters have no such wiring yet. Configure MCP only for
`provider: anthropic` Kshetras.

---

## Verify & troubleshoot

**Confirm a server connected.** After `shreni start`, watch the executor's session
logs. A connected server reports `status: connected` and its tools appear in the
injected tool schema; an executor with no MCP shows none. (See [Logs](../../README.md#logs)
for where session output lands.)

**Common failures and what they look like:**

| Symptom | Cause | Fix |
|---|---|---|
| Fail-loud before spawn: `MCP config file for role "silpi" not found: …` | A `mcpConfigFiles` path doesn't exist on disk (resolved against `repo.path`) | Create the file, or fix the path. Paths are **repo-relative**. |
| Fail-loud before spawn: `MCP server "jira" requires env var JIRA_API_TOKEN, but it is unset` | Method A `secretEnv` names an env var that isn't exported | `export JIRA_API_TOKEN=…` before `shreni start`. |
| Schema error: `grant references undefined MCP server "linear"` | A grant names a server not defined under `mcp.servers` | Define it under `mcp.servers`, or remove the grant. |
| `console.warn` "…mcpConfigFiles wins; the grant is ignored" | The role sets **both** methods | Expected if intentional; otherwise drop one. |
| Executor runs with no tools, no error | You dropped `--strict-mcp-config` / relied on an ambient `.mcp.json` in headless mode → silently skipped by the trust gate | Point at the file explicitly with `mcpConfigFiles` (Method B). |
| Executor can *write* to the external system unexpectedly | Bypass mode makes the whole server callable; a write-capable token/server was granted | Point the role at a **read-scoped** token or server. |

**Both fail-loud errors happen *before* the agent session starts**, matching
Shreni's "misconfiguration fails at config time, never silently at the first tool
call" philosophy.

---

## Related

- [docs/architecture/mcp-grounding.md](../architecture/mcp-grounding.md) — the
  design/spine: the connection/callability split, the supervised/autonomous
  asymmetry, and the full security model.
- The Kshetra config schema lives in `src/kshetra/config.ts`; the resolver in
  `src/kshetra/mcp-connect.ts` (`resolveExecutorMcp`).
