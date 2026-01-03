"""Minimal base window abstraction used by the frontend."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class BaseWindow:
    """Representation of a frontend window."""

    title: str
    session_id: str
    route: str = "/"
    dev_mode: bool = False
    window_id: Optional[str] = None

    def set_route(self, route: str) -> None:
        """Update the active route for the window."""
        self.route = route

    def tag_as_dev(self) -> None:
        """Mark the window as running in development mode."""
        self.dev_mode = True

    def attach_id(self, window_id: str) -> None:
        """Assign an identifier after creation."""
        self.window_id = window_id
