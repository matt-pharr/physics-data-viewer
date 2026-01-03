"""Double-click handler for invoking backend methods from tree nodes."""

from __future__ import annotations

from typing import Optional, Sequence

from platform.gui.client import BackendClient
from platform.gui.data_viewer.tree_view import TreeNode
from platform.gui.result_display import ResultWindow, DisplayResult
from platform.utils.introspection import describe_capabilities


class DoubleClickInvoker:
    """Resolve and invoke default methods when a node is double-clicked."""

    def __init__(self, client: BackendClient, result_window: Optional[ResultWindow] = None) -> None:
        self.client = client
        self.result_window = result_window or ResultWindow()

    async def handle_double_click(self, session_id: str, node: TreeNode) -> DisplayResult:
        """Invoke the most appropriate method for a given node and record the result."""
        method_name = await self._resolve_method(session_id, node)
        backend_path = self._backend_path(node)
        invoke_result = await self.client.invoke_method(session_id, backend_path, method_name)
        return self.result_window.add_result(invoke_result)

    async def _resolve_method(self, session_id: str, node: TreeNode) -> str:
        capabilities = describe_capabilities(node.value)
        if capabilities.get("show"):
            return "show"
        if capabilities.get("plot"):
            return "plot"
        methods = await self.client.list_methods(session_id, self._backend_path(node))
        for method in methods:
            if not method.requires_arguments:
                return method.name
        raise RuntimeError(f"No invokable methods found for path {'/'.join(node.path)}")

    async def preload_methods(self, session_id: str, path: Sequence[str]):
        """Eagerly fetch methods for a path to warm caches (useful for UI snappiness)."""
        await self.client.list_methods(session_id, path)

    @staticmethod
    def _backend_path(node: TreeNode) -> Sequence[str]:
        """Translate tree node paths to backend state paths (strip synthetic root)."""
        if node.path and node.path[0] == "root":
            return node.path[1:]
        return node.path
