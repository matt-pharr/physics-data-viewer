"""Context menu helpers backed by backend method introspection."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable, List, Sequence

from .client import BackendClient, InvokeResult, MethodInfo


Runner = Callable[[], Awaitable[Any] | Any]


@dataclass
class ContextMenuItem:
    """Single actionable entry in a context menu."""

    label: str
    method_name: str
    enabled: bool
    _runner: Runner

    async def trigger(self) -> Any:
        """Execute the associated action."""
        if not self.enabled:
            raise RuntimeError(f"Menu item '{self.label}' is disabled.")
        result = self._runner()
        if inspect.isawaitable(result):
            return await result
        return result


@dataclass
class ContextMenu:
    """Representation of a rendered context menu."""

    items: List[ContextMenuItem]

    def labels(self) -> List[str]:
        """Return item labels for display assertions."""
        return [item.label for item in self.items]


class ContextMenuBuilder:
    """Build context menus by introspecting backend state."""

    def __init__(self, client: BackendClient) -> None:
        self.client = client

    async def build(self, session_id: str, path: Sequence[str]) -> ContextMenu:
        """Fetch method metadata and construct menu entries."""
        methods = await self.client.list_methods(session_id, path)
        menu_items = [self._create_item(method, session_id, path) for method in methods]
        return ContextMenu(items=menu_items)

    def _create_item(self, method: MethodInfo, session_id: str, path: Sequence[str]) -> ContextMenuItem:
        cached_path: Iterable[str] = tuple(path)

        async def _runner() -> Any:
            invoke: InvokeResult = await self.client.invoke_method(session_id, cached_path, method.name)
            return invoke.result

        return ContextMenuItem(label=method.name, method_name=method.name, enabled=not method.requires_arguments, _runner=_runner)


__all__ = ["ContextMenu", "ContextMenuBuilder", "ContextMenuItem"]
