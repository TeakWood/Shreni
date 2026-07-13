#!/usr/bin/env bash
# Certification backlog for the go-service pack (run by scripts/certify-pack.ts
# with cwd = the scaffolded fixture repo and BEADS_DIR pointing at its beads db).
# No install step: the Go toolchain resolves the (stdlib-only) module itself.
set -euo pipefail

bd create \
  --title="Add Store.Delete(id) with table tests" \
  --description="Add Delete(id int) error to internal/notes.Store: remove the note, return ErrNotFound when missing. Table-driven tests for the success and missing cases. Remember the suite runs -race: keep the mutex discipline." \
  --type=feature --priority=1

bd create \
  --title="Add POST /notes creating a note from a JSON body" \
  --description="Add POST /notes to internal/httpapi: decode {\"title\": string}, reject an empty/invalid body with 400, delegate to Store.Add, return 201 with the created note. httptest coverage for success and invalid-body cases. Follow .shreni/style-guide.md." \
  --type=feature --priority=1

bd create \
  --title="Add a rename endpoint PUT /notes/{id}" \
  --description="Implement exactly as specified: add Store.Rename(id int, title string) that updates the note's title (return values may be ignored at the call site with _ =), and PUT /notes/{id} calling it and always responding 200. Keep it minimal — do not add anything not specified here." \
  --type=feature --priority=2
