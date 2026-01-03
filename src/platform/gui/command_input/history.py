"""Command history management for Python REPL input."""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional


class CommandHistory:
    """Manages command history with navigation and persistence."""

    def __init__(self, max_size: int = 1000, history_file: Optional[Path] = None) -> None:
        """
        Initialize the command history manager.

        Args:
            max_size: Maximum number of commands to keep in history
            history_file: Optional file path for persisting history
        """
        self.max_size = max_size
        self.history_file = history_file
        self._commands: List[str] = []
        self._current_index: int = -1

        if history_file and history_file.exists():
            self._load_from_file()

    def add(self, command: str) -> None:
        """
        Add a command to the history.

        Args:
            command: The command to add (empty commands are ignored)
        """
        if not command or not command.strip():
            return

        # Don't add duplicate consecutive commands
        if self._commands and self._commands[-1] == command:
            self._reset_navigation()
            return

        self._commands.append(command)

        # Enforce max size
        if len(self._commands) > self.max_size:
            self._commands = self._commands[-self.max_size :]

        self._reset_navigation()

        if self.history_file:
            self._save_to_file()

    def previous(self) -> Optional[str]:
        """
        Navigate to the previous command in history.

        Returns:
            The previous command, or None if at the beginning
        """
        if not self._commands:
            return None

        if self._current_index == -1:
            self._current_index = len(self._commands) - 1
        elif self._current_index > 0:
            self._current_index -= 1

        return self._commands[self._current_index]

    def next(self) -> Optional[str]:
        """
        Navigate to the next command in history.

        Returns:
            The next command, or None if at the end
        """
        if not self._commands or self._current_index == -1:
            return None

        if self._current_index < len(self._commands) - 1:
            self._current_index += 1
            return self._commands[self._current_index]
        else:
            # At the end, reset to allow new input
            self._reset_navigation()
            return ""

    def get_all(self) -> List[str]:
        """
        Get all commands in history.

        Returns:
            List of all commands in chronological order
        """
        return self._commands.copy()

    def clear(self) -> None:
        """Clear all history."""
        self._commands.clear()
        self._reset_navigation()

        if self.history_file:
            self._save_to_file()

    def search(self, query: str) -> List[str]:
        """
        Search for commands containing the query string.

        Args:
            query: The search string

        Returns:
            List of matching commands in chronological order
        """
        if not query:
            return []

        return [cmd for cmd in self._commands if query in cmd]

    def _reset_navigation(self) -> None:
        """Reset the navigation index to allow new input."""
        self._current_index = -1

    def _save_to_file(self) -> None:
        """Save history to file."""
        if not self.history_file:
            return

        try:
            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.history_file, "w") as f:
                json.dump(self._commands, f, indent=2)
        except (OSError, IOError) as e:
            # Silently fail if we can't write to the file
            # This is not critical functionality
            pass

    def _load_from_file(self) -> None:
        """Load history from file."""
        if not self.history_file or not self.history_file.exists():
            return

        try:
            with open(self.history_file, "r") as f:
                data = json.load(f)
                if isinstance(data, list):
                    self._commands = data[-self.max_size :]
        except (OSError, IOError, json.JSONDecodeError) as e:
            # If we can't load, just start with empty history
            pass
