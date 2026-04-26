"""
Tests for PDVApp.add_file() and PDVApp.new_note() in namespace.py.

Covers:
- add_file: copies file to UUID-based storage, returns PDVFile.
- add_file: raises FileNotFoundError for missing source.
- add_file: raises ValueError for directory source.
- add_file: raises PDVError when tree has no working dir.
- add_file: tilde expansion works.
- new_note: creates .md file in UUID storage, attaches to tree.
- new_note: initializes with title header when provided.
- new_note: creates empty file when no title.
- new_note: does nothing when tree is None.
"""

import os
from unittest.mock import MagicMock, patch

import pytest

import pdv.comms as comms_mod
from pdv.errors import PDVError
from pdv.namespace import PDVApp
from pdv.tree import PDVFile, PDVNote, PDVTree


class TestAddFile:
    def test_copies_file_and_returns_pdvfile(self, tree_with_comm, tmp_path):
        source = tmp_path / "input.csv"
        source.write_text("a,b,c\n1,2,3\n")

        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = app.add_file(str(source))

        assert isinstance(result, PDVFile)
        assert result.filename == "input.csv"
        assert len(result.uuid) == 12

        dest = os.path.join(
            tree_with_comm._working_dir, "tree", result.uuid, "input.csv"
        )
        assert os.path.exists(dest)
        assert open(dest).read() == "a,b,c\n1,2,3\n"

    def test_original_file_not_moved(self, tree_with_comm, tmp_path):
        source = tmp_path / "keep_me.txt"
        source.write_text("original")

        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            app.add_file(str(source))

        assert source.exists()
        assert source.read_text() == "original"

    def test_binary_file_preserved(self, tree_with_comm, tmp_path):
        source = tmp_path / "data.bin"
        binary_data = bytes(range(256))
        source.write_bytes(binary_data)

        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = app.add_file(str(source))

        dest = os.path.join(
            tree_with_comm._working_dir, "tree", result.uuid, "data.bin"
        )
        assert open(dest, "rb").read() == binary_data

    def test_raises_for_missing_source(self, tree_with_comm):
        app = PDVApp()
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            pytest.raises(FileNotFoundError, match="not found"),
        ):
            app.add_file("/no/such/file.txt")

    def test_raises_for_directory_source(self, tree_with_comm, tmp_path):
        dir_path = tmp_path / "some_dir"
        dir_path.mkdir()

        app = PDVApp()
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            pytest.raises(ValueError, match="not a file"),
        ):
            app.add_file(str(dir_path))

    def test_raises_when_no_working_dir(self, tmp_path):
        source = tmp_path / "exists.txt"
        source.write_text("data")
        tree = PDVTree()
        app = PDVApp()
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree),
            pytest.raises(PDVError, match="not available"),
        ):
            app.add_file(str(source))

    def test_tilde_expansion(self, tree_with_comm, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        source = tmp_path / "doc.txt"
        source.write_text("hello")

        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = app.add_file("~/doc.txt")

        assert isinstance(result, PDVFile)
        assert result.filename == "doc.txt"


class TestNewNote:
    def test_creates_note_in_tree(self, tree_with_comm):
        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            app.new_note("notes.intro", title="Introduction")

        note = tree_with_comm["notes.intro"]
        assert isinstance(note, PDVNote)
        assert note.filename == "intro.md"
        assert note.title == "Introduction"
        assert len(note.uuid) == 12

    def test_file_initialized_with_title_header(self, tree_with_comm):
        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            app.new_note("notes.physics", title="Physics Notes")

        note = tree_with_comm["notes.physics"]
        file_path = os.path.join(
            tree_with_comm._working_dir, "tree", note.uuid, "physics.md"
        )
        assert os.path.exists(file_path)
        content = open(file_path, encoding="utf-8").read()
        assert content == "# Physics Notes\n"

    def test_file_empty_when_no_title(self, tree_with_comm):
        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            app.new_note("notes.blank")

        note = tree_with_comm["notes.blank"]
        file_path = os.path.join(
            tree_with_comm._working_dir, "tree", note.uuid, "blank.md"
        )
        assert os.path.exists(file_path)
        content = open(file_path, encoding="utf-8").read()
        assert content == ""

    def test_noop_when_tree_is_none(self, capsys):
        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=None):
            app.new_note("notes.ghost", title="Ghost")

        captured = capsys.readouterr()
        assert "not initialized" in captured.out

    def test_nested_path_creates_intermediate_folders(self, tree_with_comm):
        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            app.new_note("docs.section.intro", title="Intro")

        note = tree_with_comm["docs.section.intro"]
        assert isinstance(note, PDVNote)

    def test_prints_confirmation(self, tree_with_comm, capsys):
        app = PDVApp()
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            app.new_note("notes.hello", title="Hello")

        captured = capsys.readouterr()
        assert "notes.hello" in captured.out
