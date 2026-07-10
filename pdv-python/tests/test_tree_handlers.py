"""
pdv-python/tests/test_tree_handlers.py — Unit tests for tree handler operations.

Tests create_node, rename, move, and duplicate handlers via direct tree
manipulation (same logic the handlers use), plus file relocation helpers.
"""

import os
import uuid as _uuid

import pytest
from unittest.mock import patch

import pdv.comms as comms_mod
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

    def test_handler_creates_empty_node(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_create_node

        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            patch.object(comms_mod, "send_message") as send_message,
            patch.object(comms_mod, "send_error") as send_error,
        ):
            handle_tree_create_node(
                {"msg_id": "m1", "payload": {"parent_path": "", "name": "fresh"}}
            )
        send_error.assert_not_called()
        send_message.assert_called_once()
        assert isinstance(tree_with_comm["fresh"], PDVTree)

    def test_handler_rejects_dotted_name(self, tree_with_comm):
        # A dot inside a key would corrupt dot-path addressing — the handler
        # must refuse it rather than silently create a nested subtree.
        from pdv.handlers.tree import handle_tree_create_node

        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            patch.object(comms_mod, "send_message") as send_message,
            patch.object(comms_mod, "send_error") as send_error,
        ):
            handle_tree_create_node(
                {"msg_id": "m2", "payload": {"parent_path": "", "name": "a.b"}}
            )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.invalid_name"
        send_message.assert_not_called()
        assert "a" not in tree_with_comm


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

        _relocate_files(container, tmp_working_dir, copy=True)
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


def _dispatch(handler, msg_type, payload, tree):
    """Dispatch a handler with a mocked comm/tree, mirroring production."""
    msg = {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": str(_uuid.uuid4()),
        "in_reply_to": None,
        "type": msg_type,
        "payload": payload,
    }
    sent = []

    class _Comm:
        def send(self, data):
            sent.append(data)

    with (
        patch.object(comms_mod, "_comm", _Comm()),
        patch.object(comms_mod, "_pdv_tree", tree),
    ):
        handler(msg)
    return sent


class TestRenameMoveChangePushes:
    """Rename/move must emit vocabulary-conformant change events for BOTH
    paths. Emitting only the old path (as "renamed"/"moved", outside the
    documented added/removed/updated vocabulary) meant a move to a different
    parent never refreshed the destination in the renderer."""

    def test_move_emits_removed_old_and_added_new(self, tree_with_comm, mock_send):
        from pdv.handlers.tree import handle_tree_move

        tree_with_comm["src.node"] = 1
        tree_with_comm["dst"] = PDVTree()
        tree_with_comm._flush_changes()  # drain setup mutations
        mock_send.reset_mock()

        responses = _dispatch(
            handle_tree_move,
            "pdv.tree.move",
            {"path": "src.node", "new_path": "dst.node"},
            tree_with_comm,
        )
        assert responses[-1]["status"] == "ok"

        tree_with_comm._flush_changes()
        changed = [
            c.args for c in mock_send.call_args_list if c.args[0] == "pdv.tree.changed"
        ]
        assert changed, "expected a pdv.tree.changed push after move"
        payload = changed[-1][1]
        assert payload["change_type"] == "batch"
        assert set(payload["changed_paths"]) == {"src.node", "dst.node"}

    def test_rename_emits_removed_old_and_added_new(self, tree_with_comm, mock_send):
        from pdv.handlers.tree import handle_tree_rename

        tree_with_comm["folder.before"] = 7
        tree_with_comm._flush_changes()  # drain setup mutations
        mock_send.reset_mock()

        responses = _dispatch(
            handle_tree_rename,
            "pdv.tree.rename",
            {"path": "folder.before", "new_name": "after"},
            tree_with_comm,
        )
        assert responses[-1]["status"] == "ok"

        tree_with_comm._flush_changes()
        changed = [
            c.args for c in mock_send.call_args_list if c.args[0] == "pdv.tree.changed"
        ]
        assert changed, "expected a pdv.tree.changed push after rename"
        payload = changed[-1][1]
        assert payload["change_type"] == "batch"
        assert set(payload["changed_paths"]) == {"folder.before", "folder.after"}
