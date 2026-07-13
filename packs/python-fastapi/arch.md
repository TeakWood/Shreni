# Architecture — FastAPI service

> Materialized from the `python-fastapi` pack. Replace the placeholders with
> your project's real notes; keep the layer boundaries.

## Layout

```
app/
  main.py            # FastAPI app factory + router registration
  routers/           # HTTP boundary — pydantic in, pydantic out, thin
  services/          # business logic, framework-free
  models.py          # pydantic models shared across layers
tests/               # pytest + TestClient, mirrors app/ structure
pyproject.toml       # deps + [tool.ruff]; uv is the environment manager
```

## Rules of the road

- Routers never contain business logic; services never import FastAPI.
- Everything crossing the HTTP boundary is a pydantic model — request bodies,
  responses, and error payloads.
- Runtime wiring (db, settings) flows through `Depends`, so tests can override
  dependencies without patching modules.
- The environment question is settled: **uv-first**. If a gate fails with
  "command not found", fix the environment (uv sync), don't bypass the gate.
