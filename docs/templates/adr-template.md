---
title: <short decision title>
status: proposed          # proposed | accepted | superseded
date: YYYY-MM-DD          # the date this decision was recorded; matches the filename
superseded-by:            # empty while this ADR stands; else the filename of its replacement
---

# <short decision title>

## Context

What problem or force prompted this decision? The user and their need, the "why
now", and any constraints that shape the solution space.

## Decision

The decision, stated plainly. Name the chosen approach and the key components /
touch-points in **real files**.

## Alternatives considered

What else was weighed, and why it was not chosen.

## Consequences

What this decision makes easier, harder, or risky — and any follow-up it implies.

<!--
Convention (see docs/guides/adr-convention.md):
- Filename: .shreni/design/YYYY-MM-DD-<slug>.md
- Immutable once the epic closes. To change a decision, write a NEW dated ADR and
  set this file's status: superseded + superseded-by: <new filename>.
-->
