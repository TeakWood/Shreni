# ADR convention (`.shreni/design/`)

A Kshetra's design decisions live as **Architecture Decision Records (ADRs)** under
`.shreni/design/` (the `DESIGN_DIR` a Suthradhara planning session writes to). This
document defines the file convention every ADR follows so the design history is
append-only, dateable, and traceable across supersessions.

> Scope: this is the **convention** (epic l4y.1). Rewiring the Suthradhara
> completion protocol to emit dated ADRs is a follow-up (l4y.2).

## Filename — dated, slugged

```
.shreni/design/YYYY-MM-DD-<slug>.md
```

- **`YYYY-MM-DD`** — the date the decision was recorded (ISO 8601, zero-padded).
  Dating the filename makes the design subtree sort chronologically and gives each
  decision a stable, collision-resistant identity.
- **`<slug>`** — a short kebab-case topic (e.g. `sso-login`, `per-role-provider`).

Example: `.shreni/design/2026-09-16-sso-login.md`.

## Frontmatter

Every ADR opens with YAML frontmatter:

```yaml
---
title: SSO login
status: accepted          # proposed | accepted | superseded
date: 2026-09-16          # matches the filename date
superseded-by:            # empty, or the filename of the ADR that replaces this one
---
```

- **`status`**
  - `proposed` — under discussion, not yet adopted.
  - `accepted` — the decision in force.
  - `superseded` — replaced by a later ADR (see `superseded-by`).
- **`superseded-by`** — empty while the ADR stands; when a later decision replaces
  it, set this to the **filename** of the superseding ADR (e.g.
  `2027-01-10-sso-login-oidc.md`). This makes the chain of decisions traversable.

## Immutability

**An ADR is immutable once its epic closes.** The record is a point-in-time
decision, not a living document — editing it would rewrite history.

To change a decision, **write a NEW dated ADR** that supersedes the old one:

1. Create `YYYY-MM-DD-<slug>.md` with the new decision (`status: accepted`).
2. In the old ADR, set `status: superseded` and `superseded-by: <new filename>`.
   (Updating these two frontmatter fields on supersession is the *only* permitted
   post-close edit.)

The result is an append-only trail: the current decision is the newest ADR whose
`status` is `accepted`, and each superseded ADR points forward to its replacement.

## Template

Copy [`docs/templates/adr-template.md`](../templates/adr-template.md) to
`.shreni/design/YYYY-MM-DD-<slug>.md` and fill it in.
