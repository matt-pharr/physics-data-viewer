"""FastAPI application bootstrap for the backend server."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from .api import router
from .executor import SubprocessExecutor
from .state import StateManager

LOG = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    state_manager = StateManager()
    executor = SubprocessExecutor(state_manager)

    app = FastAPI(
        title="Physics Data Viewer Backend",
        version="0.1.0",
        description="Async backend server for command execution and state management.",
    )

    app.state.state_manager = state_manager
    app.state.executor = executor

    @app.on_event("startup")
    async def _startup() -> None:
        LOG.info("Starting backend server")
        executor.start()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        LOG.info("Shutting down backend server")
        executor.shutdown()

    app.include_router(router)
    return app


app = create_app()
