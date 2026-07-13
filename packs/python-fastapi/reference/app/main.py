from fastapi import FastAPI

from app.routers.items import router as items_router


def create_app() -> FastAPI:
    app = FastAPI(title="fastapi-mini")

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(items_router)
    return app


app = create_app()
