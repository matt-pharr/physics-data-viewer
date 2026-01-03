"""Window manager handling multi-window support."""

from __future__ import annotations

import itertools
from typing import Dict, Iterable, Optional

from .base_window import BaseWindow


class WindowManager:
    """Manage BaseWindow instances and multi-window lifecycle."""

    def __init__(self) -> None:
        self._counter = itertools.count(1)
        self._windows: Dict[str, BaseWindow] = {}

    def create_window(self, *, title: str, session_id: str, route: str = "/", dev_mode: bool = False) -> BaseWindow:
        """Instantiate and register a new window."""
        window = BaseWindow(title=title, session_id=session_id, route=route, dev_mode=dev_mode)
        window_id = f"win-{next(self._counter)}"
        window.attach_id(window_id)
        if dev_mode:
            window.tag_as_dev()
        self._windows[window_id] = window
        return window

    def get_window(self, window_id: str) -> Optional[BaseWindow]:
        """Retrieve a window by id."""
        return self._windows.get(window_id)

    def close_window(self, window_id: str) -> None:
        """Close and remove a window if it exists."""
        self._windows.pop(window_id, None)

    def list_windows(self) -> Iterable[BaseWindow]:
        """Yield all active windows."""
        return tuple(self._windows.values())

    @property
    def count(self) -> int:
        """Number of active windows."""
        return len(self._windows)

