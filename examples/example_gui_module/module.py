"""Example module demonstrating UI panel registration."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from platform.modules.base import BaseModule
from platform.modules.context import ModuleContext
from platform.modules.manifest import ModuleManifest


class Module(BaseModule):
    """Reference module that exposes a UI panel and lazy ProjectTree data."""

    def __init__(self, manifest: ModuleManifest):
        super().__init__(manifest)
        self._context: Optional[ModuleContext] = None

    def initialize(self, context: Optional[ModuleContext] = None) -> None:  # type: ignore[override]
        self._context = context
        if context:
            context.expose_lazy_data(
                ["example_gui", "lazy_dataset"],
                loader=self._build_lazy_dataset,
                preview="rows: 3",
                metadata={"preview": "rows: 3", "kind": "example"},
            )
            context.register_panel(
                title="Example GUI Panel",
                description="Shows module-provided status and ProjectTree data.",
                render=self.render_panel,
                panel_id="example_gui:summary",
            )
        self.mark_initialized()

    def render_panel(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "sections": [
                {
                    "title": "Module Status",
                    "items": [
                        {"label": "Module", "value": self.name},
                        {"label": "Version", "value": self.version},
                    ],
                },
                {
                    "title": "Lazy Dataset",
                    "items": [
                        {"label": "Preview", "value": "rows: 3"},
                        {"label": "Path", "value": "project.example_gui.lazy_dataset"},
                    ],
                },
            ]
        }
        if self._context:
            payload["state"] = {"project_keys": list(self._context.project_tree.keys())}
        return payload

    def _build_lazy_dataset(self) -> Dict[str, List[Dict[str, Any]]]:
        return {"rows": [{"index": idx, "value": idx * idx} for idx in range(3)]}

    def shutdown(self) -> None:
        if self._context:
            self._context.cleanup()
