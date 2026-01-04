"""FastAPI application bootstrap for the backend server."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
import os
from pathlib import Path

from fastapi import FastAPI

from .api import router
from .autocomplete import AutocompleteEngine
from .executor import SubprocessExecutor
from .introspection import MethodExecutionService, MethodIntrospector
from .method_executor import MethodExecutor
from .state import StateManager
from platform.modules.context import ModuleContext
from platform.modules.loader import load_all
from platform.modules.ui_registry import UIRegistry
from platform.state.project_tree import get_project_tree

LOG = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    project_tree = get_project_tree()
    project_tree.reset(clear_observers=True)
    state_manager = StateManager()
    executor = SubprocessExecutor(state_manager)
    introspector = MethodIntrospector()
    method_execution_service = MethodExecutionService(state_manager, introspector)
    method_executor = MethodExecutor(state_manager, introspector, method_execution_service)
    autocomplete_engine = AutocompleteEngine()
    ui_registry = UIRegistry()
    modules_dir = Path(os.environ.get("PDV_MODULES_DIR", "modules"))

    def _context_factory(manifest):
        return ModuleContext(
            manifest=manifest,
            state_manager=state_manager,
            project_tree=project_tree,
            ui_registry=ui_registry,
            executor=executor,
        )

    module_load_result = load_all(modules_dir, context_factory=_context_factory)
    if module_load_result.errors:
        for error in module_load_result.errors:
            LOG.warning("Module load error: %s", error)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        LOG.info("Starting backend server")
        executor.start()
        try:
            yield
        finally:
            LOG.info("Shutting down backend server")
            module_load_result.shutdown_all()
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
    app.state.project_tree = project_tree
    app.state.ui_registry = ui_registry
    app.include_router(router)
    return app


app = create_app()
