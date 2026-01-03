"""Unit tests for command history manager."""

import json
from pathlib import Path

import pytest

from platform.gui.command_input.history import CommandHistory


class TestCommandHistory:
    """Tests for the CommandHistory class."""

    def test_initialization(self):
        """Test that history initializes correctly."""
        history = CommandHistory()
        assert history is not None
        assert history.get_all() == []

    def test_add_command(self):
        """Test adding commands to history."""
        history = CommandHistory()
        history.add("x = 1")
        assert history.get_all() == ["x = 1"]

    def test_add_multiple_commands(self):
        """Test adding multiple commands."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")
        history.add("z = 3")
        assert history.get_all() == ["x = 1", "y = 2", "z = 3"]

    def test_ignore_empty_commands(self):
        """Test that empty commands are ignored."""
        history = CommandHistory()
        history.add("")
        history.add("   ")
        assert history.get_all() == []

    def test_ignore_duplicate_consecutive_commands(self):
        """Test that duplicate consecutive commands are ignored."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("x = 1")
        history.add("y = 2")
        history.add("y = 2")
        assert history.get_all() == ["x = 1", "y = 2"]

    def test_allow_duplicate_non_consecutive_commands(self):
        """Test that duplicate non-consecutive commands are allowed."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")
        history.add("x = 1")
        assert history.get_all() == ["x = 1", "y = 2", "x = 1"]

    def test_previous_navigation(self):
        """Test navigating to previous commands."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")
        history.add("z = 3")

        assert history.previous() == "z = 3"
        assert history.previous() == "y = 2"
        assert history.previous() == "x = 1"
        assert history.previous() == "x = 1"  # Should stay at the beginning

    def test_next_navigation(self):
        """Test navigating to next commands."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")
        history.add("z = 3")

        history.previous()
        history.previous()
        history.previous()

        assert history.next() == "y = 2"
        assert history.next() == "z = 3"
        assert history.next() == ""  # Should reset to allow new input

    def test_previous_on_empty_history(self):
        """Test previous navigation on empty history."""
        history = CommandHistory()
        assert history.previous() is None

    def test_next_on_empty_history(self):
        """Test next navigation on empty history."""
        history = CommandHistory()
        assert history.next() is None

    def test_max_size_enforcement(self):
        """Test that max size is enforced."""
        history = CommandHistory(max_size=3)
        history.add("x = 1")
        history.add("y = 2")
        history.add("z = 3")
        history.add("w = 4")

        assert history.get_all() == ["y = 2", "z = 3", "w = 4"]

    def test_clear_history(self):
        """Test clearing history."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")
        history.clear()
        assert history.get_all() == []

    def test_search(self):
        """Test searching history."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")
        history.add("import numpy")
        history.add("z = 3")

        results = history.search("import")
        assert results == ["import numpy"]

    def test_search_empty_query(self):
        """Test searching with empty query."""
        history = CommandHistory()
        history.add("x = 1")
        assert history.search("") == []

    def test_search_multiple_matches(self):
        """Test searching with multiple matches."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("x = 2")
        history.add("y = 3")
        history.add("x = 4")

        results = history.search("x =")
        assert results == ["x = 1", "x = 2", "x = 4"]

    def test_persistence_save_and_load(self, tmp_path: Path):
        """Test saving and loading history from file."""
        history_file = tmp_path / "history.json"

        # Create history and add commands
        history1 = CommandHistory(history_file=history_file)
        history1.add("x = 1")
        history1.add("y = 2")

        # Load history in a new instance
        history2 = CommandHistory(history_file=history_file)
        assert history2.get_all() == ["x = 1", "y = 2"]

    def test_persistence_clear(self, tmp_path: Path):
        """Test that clearing history updates the file."""
        history_file = tmp_path / "history.json"

        history1 = CommandHistory(history_file=history_file)
        history1.add("x = 1")
        history1.clear()

        history2 = CommandHistory(history_file=history_file)
        assert history2.get_all() == []

    def test_persistence_max_size(self, tmp_path: Path):
        """Test that max size is respected when loading from file."""
        history_file = tmp_path / "history.json"

        # Save more commands than max_size
        history1 = CommandHistory(max_size=1000, history_file=history_file)
        for i in range(10):
            history1.add(f"cmd_{i}")

        # Load with smaller max_size
        history2 = CommandHistory(max_size=5, history_file=history_file)
        assert len(history2.get_all()) == 5
        assert history2.get_all() == ["cmd_5", "cmd_6", "cmd_7", "cmd_8", "cmd_9"]

    def test_persistence_corrupted_file(self, tmp_path: Path):
        """Test handling of corrupted history file."""
        history_file = tmp_path / "history.json"
        history_file.write_text("not valid json")

        # Should not crash, just start with empty history
        history = CommandHistory(history_file=history_file)
        assert history.get_all() == []

    def test_persistence_nonexistent_file(self, tmp_path: Path):
        """Test loading from nonexistent file."""
        history_file = tmp_path / "nonexistent" / "history.json"

        # Should not crash, just start with empty history
        history = CommandHistory(history_file=history_file)
        assert history.get_all() == []

    def test_navigation_reset_after_add(self):
        """Test that navigation index resets after adding a command."""
        history = CommandHistory()
        history.add("x = 1")
        history.add("y = 2")

        history.previous()
        assert history.previous() == "x = 1"

        history.add("z = 3")
        # After adding, navigation should reset
        assert history.previous() == "z = 3"
