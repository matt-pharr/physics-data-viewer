"""FastAPI application bootstrap for the backend server."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .api import router
from .autocomplete import AutocompleteEngine
from .executor import SubprocessExecutor
from .introspection import MethodExecutionService, MethodIntrospector
from .method_executor import MethodExecutor
from .state import StateManager

LOG = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    state_manager = StateManager()
    executor = SubprocessExecutor(state_manager)
    introspector = MethodIntrospector()
    method_execution_service = MethodExecutionService(state_manager, introspector)
    method_executor = MethodExecutor(state_manager, introspector, method_execution_service)
    autocomplete_engine = AutocompleteEngine()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        LOG.info("Starting backend server")
        executor.start()
        try:
            yield
        finally:
            LOG.info("Shutting down backend server")
        executor.shutdown()

    app = FastAPI(
        title="Physics Data Viewer Backend",
        version="0.1.0",
        description="Async backend server for command execution and state management.",
        lifespan=lifespan,
    )

    app.state.state_manager = state_manager
    app.state.executor = executor
    app.state.introspector = introspector
    app.state.method_execution = method_executor
    app.state.autocomplete_engine = autocomplete_engine
    app.include_router(router)
    return app


app = create_app()
