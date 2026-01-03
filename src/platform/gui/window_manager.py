"""Window manager handling multi-window support."""

from __future__ import annotations

from typing import Dict, Iterable, Optional

from .base_window import BaseWindow


class WindowManager:
    """Manage BaseWindow instances and multi-window lifecycle."""

    def __init__(self) -> None:
        self._next_id = 1
        self._windows: Dict[str, BaseWindow] = {}

    def _allocate_id(self, preferred: Optional[str] = None) -> str:
        if preferred:
            try:
                numeric = int(preferred.split("-")[-1])
                self._next_id = max(self._next_id, numeric + 1)
            except ValueError:
                pass
            return preferred
        window_id = f"win-{self._next_id}"
        self._next_id += 1
        return window_id

    def create_window(
        self, *, title: str, session_id: str, route: str = "/", dev_mode: bool = False, window_id: Optional[str] = None
    ) -> BaseWindow:
        """Instantiate and register a new window."""
        window = BaseWindow(title=title, session_id=session_id, route=route, dev_mode=dev_mode)
        assigned_id = self._allocate_id(window_id)
        window.attach_id(assigned_id)
        self._windows[assigned_id] = window
        return window

    def get_window(self, window_id: str) -> Optional[BaseWindow]:
        """Retrieve a window by id."""
        return self._windows.get(window_id)

    def close_window(self, window_id: str) -> None:
        """Close and remove a window if it exists."""
        self._windows.pop(window_id, None)

    def list_windows(self) -> Iterable[BaseWindow]:
        """Return all active windows."""
        return tuple(self._windows.values())

    @property
    def count(self) -> int:
        """Number of active windows."""
        return len(self._windows)
