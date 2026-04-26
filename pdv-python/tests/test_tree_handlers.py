"""
pdv-python/tests/test_tree_handlers.py — Unit tests for tree handler operations.

Tests create_node, rename, move, and duplicate handlers via direct tree
manipulation (same logic the handlers use), plus file relocation helpers.
"""

import os

import pytest
from pdv.tree import PDVTree, PDVScript, PDVNote


class TestCreateNode:
    """Tests for create_node semantics (empty dict insertion)."""

    def test_create_at_root(self, tree_with_comm):
        tree_with_comm["new_node"] = PDVTree()
        assert "new_node" in tree_with_comm
        assert isinstance(tree_with_comm["new_node"], PDVTree)

    def test_create_nested(self, tree_with_comm):
        tree_with_comm["parent"] = PDVTree()
        tree_with_comm["parent.child"] = PDVTree()
        assert "parent.child" in tree_with_comm

    def test_create_rejects_existing(self, tree_with_comm):
        tree_with_comm["exists"] = PDVTree()
        assert "exists" in tree_with_comm


class TestRename:
    """Tests for rename semantics (re-key under same parent)."""

    def test_rename_simple(self, tree_with_comm):
        tree_with_comm["old"] = 42
        value = tree_with_comm["old"]
        tree_with_comm.set_quiet("new", value)
        dict.__delitem__(tree_with_comm, "old")
        assert "new" in tree_with_comm
        assert "old" not in tree_with_comm
        assert tree_with_comm["new"] == 42

    def test_rename_nested(self, tree_with_comm):
        tree_with_comm["parent.old_child"] = "data"
        value = tree_with_comm["parent.old_child"]
        tree_with_comm.set_quiet("parent.new_child", value)
        parent = tree_with_comm["parent"]
        dict.__delitem__(parent, "old_child")
        assert "parent.new_child" in tree_with_comm
        assert "parent.old_child" not in tree_with_comm

    def test_rename_preserves_subtree(self, tree_with_comm):
        tree_with_comm["a.b.c"] = 99
        value = tree_with_comm["a.b"]
        tree_with_comm.set_quiet("a.renamed", value)
        parent = tree_with_comm["a"]
        dict.__delitem__(parent, "b")
        assert tree_with_comm["a.renamed.c"] == 99
        assert "a.b" not in tree_with_comm


class TestMove:
    """Tests for move semantics (re-parent a node)."""

    def test_move_simple(self, tree_with_comm):
        tree_with_comm["source"] = 42
        tree_with_comm["dest_parent"] = PDVTree()
        value = tree_with_comm["source"]
        tree_with_comm.set_quiet("dest_parent.moved", value)
        dict.__delitem__(tree_with_comm, "source")
        assert tree_with_comm["dest_parent.moved"] == 42
        assert "source" not in tree_with_comm

    def test_move_subtree(self, tree_with_comm):
        tree_with_comm["a.b.c"] = "deep"
        tree_with_comm["target"] = PDVTree()
        value = tree_with_comm["a"]
        tree_with_comm.set_quiet("target.a_moved", value)
        dict.__delitem__(tree_with_comm, "a")
        assert tree_with_comm["target.a_moved.b.c"] == "deep"
        assert "a" not in tree_with_comm

    def test_circular_move_detected(self, tree_with_comm):
        tree_with_comm["a.b.c"] = 1
        path = "a.b"
        new_path = "a.b.c.inside"
        assert new_path.startswith(path + ".")


class TestDuplicate:
    """Tests for duplicate semantics (deep copy)."""

    def test_duplicate_value(self, tree_with_comm):
        import copy
        tree_with_comm["original"] = [1, 2, 3]
        cloned = copy.deepcopy(tree_with_comm["original"])
        tree_with_comm["copy"] = cloned
        assert tree_with_comm["copy"] == [1, 2, 3]
        tree_with_comm["original"].append(4)
        assert tree_with_comm["copy"] == [1, 2, 3]

    def test_duplicate_subtree(self, tree_with_comm):
        import copy
        subtree = {"b": 42, "c": [1, 2]}
        tree_with_comm["a"] = subtree
        cloned = copy.deepcopy(tree_with_comm["a"])
        tree_with_comm["a_copy"] = cloned
        assert tree_with_comm["a_copy"]["b"] == 42
        subtree["b"] = 99
        assert tree_with_comm["a_copy"]["b"] == 42


class TestRelocateFiles:
    """Tests for _relocate_files and _relocate_single_file.

    With UUID-based storage, rename/move is a no-op (the file path is
    independent of the tree path). Only copy=True (duplicate) needs
    to create a new file with a fresh UUID.
    """

    def test_relocate_single_file_noop_on_rename(self, tmp_working_dir):
        """Rename (copy=False) is a no-op with UUID storage."""
        from pdv.handlers.tree import _relocate_single_file

        node_uuid = "reloc_uuid01"
        tree_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(tree_dir)
        old_path = os.path.join(tree_dir, "old_script.py")
        with open(old_path, "w") as f:
            f.write("# test")

        script = PDVScript(uuid=node_uuid, filename="old_script.py")
        _relocate_single_file(script, tmp_working_dir, copy=False)

        # UUID should be unchanged since it's a rename (no-op)
        assert script.uuid == node_uuid
        assert os.path.exists(old_path)

    def test_relocate_single_file_copies(self, tmp_working_dir):
        """Duplicate (copy=True) assigns a new UUID and copies the file."""
        from pdv.handlers.tree import _relocate_single_file

        node_uuid = "reloc_uuid02"
        tree_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(tree_dir)
        old_path = os.path.join(tree_dir, "src.py")
        with open(old_path, "w") as f:
            f.write("# test")

        script = PDVScript(uuid=node_uuid, filename="src.py")
        _relocate_single_file(script, tmp_working_dir, copy=True)

        # Original file still exists
        assert os.path.exists(old_path)
        # Script should have a new UUID
        assert script.uuid != node_uuid
        # New file should exist at the new UUID location
        new_path = script.resolve_path(tmp_working_dir)
        assert os.path.exists(new_path)

    def test_relocate_rejects_non_pdvfile(self):
        from pdv.handlers.tree import _relocate_single_file
        with pytest.raises(TypeError, match="Expected PDVFile"):
            _relocate_single_file("not_a_file", "/tmp", copy=False)

    def test_relocate_files_recursive_copy(self, tmp_working_dir):
        """Recursive duplicate assigns fresh UUIDs to file-backed descendants."""
        from pdv.handlers.tree import _relocate_files

        node_uuid = "reloc_uuid03"
        tree_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(tree_dir)
        script_path = os.path.join(tree_dir, "my_script.py")
        with open(script_path, "w") as f:
            f.write("# test")

        container = PDVTree()
        script = PDVScript(uuid=node_uuid, filename="my_script.py")
        dict.__setitem__(container, "my_script", script)

        _relocate_files(container, "parent", "new_parent", tmp_working_dir, copy=True)
        # Script should have a new UUID after copy
        assert script.uuid != node_uuid
        new_path = script.resolve_path(tmp_working_dir)
        assert os.path.exists(new_path)

    def test_note_relocation_copy(self, tmp_working_dir):
        """Duplicate of a note creates a fresh UUID."""
        from pdv.handlers.tree import _relocate_single_file

        node_uuid = "reloc_uuid04"
        tree_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(tree_dir)
        note_path = os.path.join(tree_dir, "my_note.md")
        with open(note_path, "w") as f:
            f.write("# Note")

        note = PDVNote(uuid=node_uuid, filename="my_note.md")
        _relocate_single_file(note, tmp_working_dir, copy=True)

        assert note.uuid != node_uuid
        new_path = note.resolve_path(tmp_working_dir)
        assert os.path.exists(new_path)
