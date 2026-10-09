#!/usr/bin/env bash
# Fixture setup for pack certification (run by scripts/certify-pack.ts with
# cwd = the scaffolded fixture repo, before the backlog in backlog.json is filed).
# The harness does not install dependencies — sync the uv environment here so the
# uv-run gates resolve (this IS the pack's environment answer).
set -euo pipefail

uv sync --quiet
