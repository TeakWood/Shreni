#!/usr/bin/env bash
# Fixture setup for pack certification (run by scripts/certify-pack.ts with
# cwd = the scaffolded fixture repo, before the backlog in backlog.json is filed).
# The harness does not install dependencies — do it here, before gates ever run.
set -euo pipefail

pnpm install --silent
