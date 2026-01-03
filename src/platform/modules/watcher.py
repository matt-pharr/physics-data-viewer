"""Filesystem watcher for module hot-reload during development."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable, Dict, Optional, Set

from .loader import MANIFEST_FILENAMES


class ModuleWatcher:
    """Lightweight polling-based watcher for module directories."""

    def __init__(self, modules_dir: Path, on_change: Callable[[Path], None], poll_interval: float = 1.0) -> None:
        self.modules_dir = modules_dir.expanduser().resolve()
        self.on_change = on_change
        self.poll_interval = poll_interval
        # Allow a short grace period for the polling loop to exit cleanly.
        self.stop_timeout = poll_interval * 2
        self._known: Dict[Path, float] = {}
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def start(self) -> None:
        """Start background polling."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop background polling."""
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=self.stop_timeout)
        self._thread = None

    def prime(self) -> None:
        """Prime watcher state without emitting change events."""
        self._known = self._current_state()

    def poll_once(self) -> None:
        """Check filesystem once and trigger callbacks for changes."""
        current = self._current_state()
        changed_dirs: Set[Path] = set()

        for path, mtime in current.items():
            if path not in self._known or self._known[path] < mtime:
                changed_dirs.add(path.parent)

        for path in list(self._known):
            if path not in current:
                changed_dirs.add(path.parent)

        self._known = current

        for module_dir in changed_dirs:
            if module_dir.exists():
                self.on_change(module_dir)

    def _run(self) -> None:
        while self._running:
            self.poll_once()
            time.sleep(self.poll_interval)

    def _current_state(self) -> Dict[Path, float]:
        state: Dict[Path, float] = {}
        if not self.modules_dir.exists():
            return state

        for child in self.modules_dir.iterdir():
            if not child.is_dir():
                continue
            manifest = self._find_manifest(child)
            if manifest and manifest.exists():
                state[manifest] = manifest.stat().st_mtime
            module_file = child / "module.py"
            if module_file.exists():
                state[module_file] = module_file.stat().st_mtime
        return state

    @staticmethod
    def _find_manifest(module_dir: Path) -> Optional[Path]:
        for candidate in MANIFEST_FILENAMES:
            path = module_dir / candidate
            if path.exists():
                return path
        return None


__all__ = ["ModuleWatcher"]
