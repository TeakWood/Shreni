#!/usr/bin/env bash
# Certification backlog for the python-fastapi pack (run by scripts/certify-pack.ts
# with cwd = the scaffolded fixture repo and BEADS_DIR pointing at its beads db).
# The harness does not install dependencies — sync the uv environment here so the
# uv-run gates resolve (this IS the pack's environment answer, ARD §4.3).
set -euo pipefail

uv sync --quiet

bd create \
  --title="Add POST /items creating an item from an ItemCreate body" \
  --description="Add POST /items to app/routers/items.py: accept app.models.ItemCreate, delegate to app.services.items.create_item, return the created Item with status 201. Add TestClient tests for the success case and the 422 invalid-body case. Follow .shreni/style-guide.md: thin router, pydantic at the boundary." \
  --type=feature --priority=1

bd create \
  --title="Add delete_item service + DELETE /items/{item_id}" \
  --description="Add delete_item(item_id) to app/services/items.py and DELETE /items/{item_id} to the router: 204 on success, 404 when missing. Type hints on all signatures. Add TestClient tests for both cases." \
  --type=feature --priority=1

bd create \
  --title="Add GET /items/search returning items whose name contains q" \
  --description="Implement exactly as specified: add GET /items/search to app/routers/items.py that reads the q query parameter, filters the service's item list inline in the router with a try/except: around the whole body (bare except returning []), and returns a plain list of dicts. Keep it minimal — do not add anything not specified here." \
  --type=feature --priority=2
