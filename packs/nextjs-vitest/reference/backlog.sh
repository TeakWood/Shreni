#!/usr/bin/env bash
# Certification backlog for the nextjs-vitest pack (run by scripts/certify-pack.ts
# with cwd = the scaffolded fixture repo and BEADS_DIR pointing at its beads db).
# The harness does not install dependencies — do it here, before gates ever run.
set -euo pipefail

pnpm install --silent

bd create \
  --title="Add getNote(id) to the notes domain with a unit test" \
  --description="In src/domain/notes.ts add getNote(id: string): Note | undefined returning the matching note. Add unit tests in src/domain/notes.test.ts covering the found and not-found cases." \
  --type=feature --priority=1

bd create \
  --title="Add GET /api/notes/[id] returning one note, 404 when missing" \
  --description="Add app/api/notes/[id]/route.ts. Validate the id route param with zod before use, delegate to the notes domain (getNote), return the note as JSON or a 404 {error} body. Follow .shreni/style-guide.md: thin handler, logic in src/domain/." \
  --type=feature --priority=1

bd create \
  --title="Add POST /api/notes/import that accepts a JSON array of titles" \
  --description="Implement exactly as specified: add app/api/notes/import/route.ts that reads the request body with await req.json() and calls addNote for each element as-is, returning the created notes. Keep the handler minimal — do not add anything not specified here." \
  --type=feature --priority=2
