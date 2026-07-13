# Review Guide — python-fastapi

Stack-specific review rubric (injected into the reviewer only). These lines are
grounds for REJECT; they add to — never replace — Shreni's hard gates.

REJECT when:

1. **Raw dicts across the HTTP boundary.** A new/changed route accepts or
   returns untyped dicts instead of pydantic models (request body, response
   model, or error payload).
2. **Route without a TestClient test.** Every new/changed route needs an httpx
   `TestClient` test covering the success case AND a failure case (422 on
   invalid input, or 404).
3. **Bare `except:`** anywhere, or an exception swallowed without handling or
   re-raising.
4. **Mutable default argument** (`def f(x=[])`, `def f(x={})`).
5. **Missing type hints on public signatures** (any exported/route-level
   function).
6. **Business logic in a router**, or a service importing FastAPI/Starlette.
7. **Environment bypass.** Commands invoked outside `uv run`, `pip install`
   into the environment, or sys.path hacks to dodge a failing import.
