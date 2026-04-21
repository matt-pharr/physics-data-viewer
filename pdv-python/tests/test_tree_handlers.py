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
    """Tests for _relocate_files and _relocate_single_file."""

    def test_relocate_single_file_moves(self, tmp_working_dir):
        from pdv.handlers.tree import _relocate_single_file

        tree_dir = os.path.join(tmp_working_dir, "tree")
        os.makedirs(tree_dir)
        old_path = os.path.join(tree_dir, "old_script.py")
        with open(old_path, "w") as f:
            f.write("# test")

        script = PDVScript(relative_path="tree/old_script.py")
        _relocate_single_file(script, "new_script", tmp_working_dir, copy=False)

        assert script.relative_path == os.path.join("tree", "new_script.py")
        new_abs = os.path.join(tmp_working_dir, "tree", "new_script.py")
        assert os.path.exists(new_abs)
        assert not os.path.exists(old_path)

    def test_relocate_single_file_copies(self, tmp_working_dir):
        from pdv.handlers.tree import _relocate_single_file

        tree_dir = os.path.join(tmp_working_dir, "tree")
        os.makedirs(tree_dir)
        old_path = os.path.join(tree_dir, "src.py")
        with open(old_path, "w") as f:
            f.write("# test")

        script = PDVScript(relative_path="tree/src.py")
        _relocate_single_file(script, "dst", tmp_working_dir, copy=True)

        assert os.path.exists(old_path)
        new_abs = os.path.join(tmp_working_dir, "tree", "dst.py")
        assert os.path.exists(new_abs)

    def test_relocate_with_filename_override(self, tmp_working_dir):
        from pdv.handlers.tree import _relocate_single_file

        tree_dir = os.path.join(tmp_working_dir, "tree")
        os.makedirs(tree_dir)
        old_path = os.path.join(tree_dir, "old.py")
        with open(old_path, "w") as f:
            f.write("# test")

        script = PDVScript(relative_path="tree/old.py")
        _relocate_single_file(script, "new_key", tmp_working_dir,
                              copy=False, filename="custom_name.py")

        assert script.relative_path == os.path.join("tree", "custom_name.py")

    def test_relocate_files_recursive(self, tmp_working_dir):
        from pdv.handlers.tree import _relocate_files

        tree_dir = os.path.join(tmp_working_dir, "tree", "parent")
        os.makedirs(tree_dir)
        script_path = os.path.join(tree_dir, "my_script.py")
        with open(script_path, "w") as f:
            f.write("# test")

        container = PDVTree()
        script = PDVScript(relative_path=os.path.join("tree", "parent", "my_script.py"))
        dict.__setitem__(container, "my_script", script)

        _relocate_files(container, "parent", "new_parent", tmp_working_dir, copy=False)
        assert script.relative_path == os.path.join("tree", "new_parent", "my_script.py")

    def test_relocate_rejects_non_pdvfile(self):
        from pdv.handlers.tree import _relocate_single_file
        with pytest.raises(TypeError, match="Expected PDVFile"):
            _relocate_single_file("not_a_file", "path", "/tmp", copy=False)

    def test_rename_relocates_backing_file(self, tmp_working_dir):
        """Rename of a file-backed node should update its _relative_path."""
        from pdv.handlers.tree import _relocate_files

        tree_dir = os.path.join(tmp_working_dir, "tree")
        os.makedirs(tree_dir)
        old_file = os.path.join(tree_dir, "old_name.py")
        with open(old_file, "w") as f:
            f.write("# script")

        script = PDVScript(relative_path="tree/old_name.py")
        _relocate_files(script, "old_name", "new_name", tmp_working_dir, copy=False)

        assert script.relative_path == os.path.join("tree", "new_name.py")
        assert os.path.exists(os.path.join(tmp_working_dir, "tree", "new_name.py"))
        assert not os.path.exists(old_file)

    def test_note_relocation(self, tmp_working_dir):
        from pdv.handlers.tree import _relocate_single_file

        tree_dir = os.path.join(tmp_working_dir, "tree")
        os.makedirs(tree_dir)
        note_path = os.path.join(tree_dir, "my_note.md")
        with open(note_path, "w") as f:
            f.write("# Note")

        note = PDVNote(relative_path="tree/my_note.md")
        _relocate_single_file(note, "renamed_note", tmp_working_dir, copy=False)

        assert note.relative_path == os.path.join("tree", "renamed_note.md")
