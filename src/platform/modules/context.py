"""Module context utilities exposed to module implementations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, Optional, Sequence, TYPE_CHECKING

from platform.modules.manifest import ModuleManifest
from platform.modules.ui_registry import UIRegistry
from platform.server.state import StateManager
from platform.state.project_tree import ProjectTree, Tree

if TYPE_CHECKING:
    from platform.server.executor import ExecutionResult, SubprocessExecutor
else:  # pragma: no cover - used only for type checking
    ExecutionResult = Any  # type: ignore[assignment]
    SubprocessExecutor = Any  # type: ignore[assignment]


@dataclass
class ModuleContext:
    """Context provided to modules for interacting with the application."""

    manifest: ModuleManifest
    state_manager: StateManager
    project_tree: ProjectTree
    ui_registry: UIRegistry
    executor: Optional[SubprocessExecutor] = None

    def register_panel(
        self,
        title: str,
        description: str,
        render: Callable[[], Dict[str, Any]],
        *,
        panel_id: Optional[str] = None,
    ) -> str:
        """Register a UI panel exposed by the module."""
        return self.ui_registry.register_panel(
            module=self.manifest.name,
            title=title,
            description=description,
            renderer=render,
            panel_id=panel_id,
        )

    def expose_lazy_data(
        self,
        path: Sequence[str],
        loader: Callable[[], Any],
        *,
        preview: str = "<lazy>",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Expose a lazy node within the global ProjectTree."""
        if not path:
            raise ValueError("Path must contain at least one key")
        cursor: Any = self.project_tree
        for key in path[:-1]:
            try:
                next_cursor = cursor[key]
            except Exception:
                next_cursor = Tree()
                if isinstance(cursor, Tree):
                    cursor[key] = next_cursor
                else:
                    raise ValueError("Cannot descend into non-tree path segment.")
            if not isinstance(next_cursor, Tree):
                raise ValueError("Cannot descend into non-tree path segment.")
            cursor = next_cursor
        if not isinstance(cursor, Tree):
            raise ValueError("Cannot attach lazy data outside a Tree container.")
        cursor.add_lazy(path[-1], loader, preview=preview, metadata=metadata)

    def set_project_value(self, path: Iterable[str], value: Any) -> None:
        """Set a concrete value inside the ProjectTree."""
        self.project_tree.set_path(list(path), value)

    def get_session_state(self, session_id: str) -> Dict[str, Any]:
        """Return a copy of the requested session state."""
        return self.state_manager.get_session_state(session_id)

    def execute_in_repl(self, code: str, session_id: Optional[str] = None, timeout: float = 5.0) -> ExecutionResult:
        """Execute Python code through the shared executor."""
        if self.executor is None:
            raise RuntimeError("Executor unavailable for this context")
        sid = session_id or self.state_manager.create_session()
        return self.executor.execute(code=code, session_id=sid, timeout=timeout)

    def cleanup(self) -> None:
        """Clean up UI resources registered by this module."""
        self.ui_registry.unregister_module(self.manifest.name)


__all__ = ["ModuleContext"]
