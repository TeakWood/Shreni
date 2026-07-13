# Style Guide — FastAPI + uv

> Materialized from the `python-fastapi` pack. This file is yours: edit it to
> match your project. Shreni's agents read it when implementing and reviewing.

## Environment

- **uv owns the environment.** Run everything through `uv run …`; never rely on
  a globally activated venv or system Python. Dependencies change via
  `uv add`/`pyproject.toml`, never `pip install`.

## Boundaries

- **pydantic models at every boundary**: request bodies, response models, and
  settings. Handlers never work with raw dicts.
- Routers stay thin: validate (pydantic does it), call a service function,
  return a model. Business logic lives in `app/services/`.
- Dependencies (db sessions, settings, auth) are injected via `Depends`, not
  imported as module globals.

## Async & typing

- `async def` for I/O paths; plain `def` for pure CPU work.
- Type hints on **all public signatures**. No bare `except:` — catch the
  narrowest exception that makes sense. No mutable default arguments.

## Testing & linting

- pytest with FastAPI's `TestClient` (httpx): every route gets a test for the
  success case and one failure case (422 invalid input or 404).
- ruff is the lint gate. A type gate is recommended: uncomment
  `buildCommand: uv run mypy .` in `.shreni/kshetra.yaml` once mypy is a dev
  dependency.
