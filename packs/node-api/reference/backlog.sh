#!/usr/bin/env bash
# Certification backlog for the node-api pack (run by scripts/certify-pack.ts
# with cwd = the scaffolded fixture repo and BEADS_DIR pointing at its beads db).
# The harness does not install dependencies — do it here, before gates ever run.
set -euo pipefail

pnpm install --silent

bd create \
  --title="Add POST /items creating an item from a zod-validated body" \
  --description="Add POST /items to src/routes/items.ts: body {name: string (1-80 chars)} validated with zod, delegate to the items service (createItem), return 201 with the created item and 400 with {error} on invalid input. Add app.inject() tests for both cases. Follow .shreni/style-guide.md layering." \
  --type=feature --priority=1

bd create \
  --title="Add deleteItem to service+repository and DELETE /items/:id" \
  --description="Add deleteItem(id) through the repository and service layers, then DELETE /items/:id: validate the id param with zod, 204 on success, 404 when missing. Add inject tests for success and missing-item cases." \
  --type=feature --priority=1

bd create \
  --title="Add PUT /items/:id that renames an item" \
  --description="Implement exactly as specified: add PUT /items/:id to src/routes/items.ts that reads req.body.name directly and updates the item's name in the repository from within the route handler. Keep it minimal — do not add anything not specified here." \
  --type=feature --priority=2
