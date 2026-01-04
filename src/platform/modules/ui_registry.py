"""UI panel registry for module-provided widgets."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional


@dataclass
class UIPanel:
    """Serializable representation of a registered UI panel."""

    panel_id: str
    module: str
    title: str
    description: str
    content: Dict[str, Any]
    updated_at: float


@dataclass
class _PanelRegistration:
    module: str
    panel_id: str
    title: str
    description: str
    renderer: Callable[[], Dict[str, Any]]
    last_render: Optional[Dict[str, Any]] = None
    updated_at: float = 0.0


class UIRegistry:
    """Registry tracking UI panels registered by modules."""

    def __init__(self) -> None:
        self._panels: Dict[str, _PanelRegistration] = {}

    def register_panel(
        self,
        module: str,
        title: str,
        description: str,
        renderer: Callable[[], Dict[str, Any]],
        panel_id: Optional[str] = None,
    ) -> str:
        """Register a UI panel and return its stable id."""
        normalized_id = panel_id or self._make_panel_id(module, title)
        registration = _PanelRegistration(
            module=module,
            panel_id=normalized_id,
            title=title,
            description=description,
            renderer=renderer,
        )
        self._panels[normalized_id] = registration
        self._refresh_registration(registration)
        return normalized_id

    def unregister_module(self, module: str) -> None:
        """Remove all panels belonging to the given module."""
        panel_ids = [panel_id for panel_id, panel in self._panels.items() if panel.module == module]
        for panel_id in panel_ids:
            self._panels.pop(panel_id, None)

    def list_panels(self) -> List[UIPanel]:
        """Return registered panels with their last rendered content."""
        return [self._to_panel(registration) for registration in self._panels.values()]

    def refresh_panel(self, panel_id: str) -> UIPanel:
        """Re-render and return a single panel."""
        registration = self._panels.get(panel_id)
        if registration is None:
            raise KeyError(f"Unknown panel id: {panel_id}")
        self._refresh_registration(registration)
        return self._to_panel(registration)

    def _refresh_registration(self, registration: _PanelRegistration) -> None:
        try:
            content = registration.renderer() or {}
        except Exception as exc:  # pragma: no cover - defensive guardrail
            content = {"error": str(exc)}
        registration.last_render = content if isinstance(content, dict) else {"content": repr(content)}
        registration.updated_at = time.time()

    def _to_panel(self, registration: _PanelRegistration) -> UIPanel:
        if registration.last_render is None:
            self._refresh_registration(registration)
        return UIPanel(
            panel_id=registration.panel_id,
            module=registration.module,
            title=registration.title,
            description=registration.description,
            content=dict(registration.last_render or {}),
            updated_at=registration.updated_at,
        )

    def _make_panel_id(self, module: str, title: str) -> str:
        base = f"{module}:{title}".lower()
        base = re.sub(r"[^a-z0-9:_-]+", "-", base).strip("-")
        candidate = base or module.lower()
        suffix = 1
        while candidate in self._panels:
            suffix += 1
            candidate = f"{base}-{suffix}"
        return candidate


__all__ = ["UIRegistry", "UIPanel"]
