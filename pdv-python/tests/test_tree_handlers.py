"""
pdv-python/tests/test_tree_handlers.py — Unit tests for tree handler operations.

Drives the real create_node / rename / move / duplicate handlers in
``pdv.handlers.tree`` (resolving the tree via ``comms.get_pdv_tree`` and
replying through ``comms.send_message`` / ``comms.send_error``, all patched
here), plus the file relocation helpers. These tests assert on the handlers'
actual replies and error codes rather than re-implementing the tree
manipulation the handlers perform.
"""

import os
import uuid as _uuid

import pytest
from unittest.mock import patch

import pdv.comms as comms_mod
from pdv.tree import PDVTree, PDVScript, PDVNote


def _run_handler(handler, payload, tree, msg_id="m"):
    """Dispatch a tree handler against *tree*, returning its
    ``(send_message, send_error)`` mocks.

    Mirrors the production path: the handler resolves the tree via
    ``comms.get_pdv_tree`` and replies via ``comms.send_message`` /
    ``comms.send_error``. On an error reply, ``send_error.call_args[0][1]`` is
    the error code (the second positional argument).
    """
    with (
        patch.object(comms_mod, "get_pdv_tree", return_value=tree),
        patch.object(comms_mod, "send_message") as send_message,
        patch.object(comms_mod, "send_error") as send_error,
    ):
        handler({"msg_id": msg_id, "payload": payload})
    return send_message, send_error


class TestCreateNode:
    """create_node handler: empty-dict insertion, dotted-name and dup guards."""

    def test_handler_creates_empty_node(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_create_node

        send_message, send_error = _run_handler(
            handle_tree_create_node,
            {"parent_path": "", "name": "fresh"},
            tree_with_comm,
        )
        send_error.assert_not_called()
        send_message.assert_called_once()
        assert isinstance(tree_with_comm["fresh"], PDVTree)

    def test_creates_nested_node(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_create_node

        _run_handler(
            handle_tree_create_node,
            {"parent_path": "", "name": "parent"},
            tree_with_comm,
        )
        send_message, send_error = _run_handler(
            handle_tree_create_node,
            {"parent_path": "parent", "name": "child"},
            tree_with_comm,
        )
        send_error.assert_not_called()
        assert isinstance(tree_with_comm["parent.child"], PDVTree)

    def test_rejects_dotted_name(self, tree_with_comm):
        # A dot inside a key would corrupt dot-path addressing — the handler
        # must refuse it rather than silently create a nested subtree.
        from pdv.handlers.tree import handle_tree_create_node

        send_message, send_error = _run_handler(
            handle_tree_create_node,
            {"parent_path": "", "name": "a.b"},
            tree_with_comm,
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.invalid_name"
        send_message.assert_not_called()
        assert "a" not in tree_with_comm

    def test_rejects_existing(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_create_node

        tree_with_comm["exists"] = PDVTree()
        send_message, send_error = _run_handler(
            handle_tree_create_node,
            {"parent_path": "", "name": "exists"},
            tree_with_comm,
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.already_exists"
        send_message.assert_not_called()

    def test_rejects_missing_parent(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_create_node

        send_message, send_error = _run_handler(
            handle_tree_create_node,
            {"parent_path": "nope", "name": "child"},
            tree_with_comm,
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.path_not_found"
        send_message.assert_not_called()


class TestDelete:
    """delete handler: remove a node by path, plus the missing-path guard."""

    def test_delete_removes_node(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_delete

        tree_with_comm["doomed"] = 1
        send_message, send_error = _run_handler(
            handle_tree_delete, {"path": "doomed"}, tree_with_comm
        )
        send_error.assert_not_called()
        send_message.assert_called_once()
        assert "doomed" not in tree_with_comm

    def test_delete_nested_node(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_delete

        tree_with_comm["a.b.c"] = 1
        send_message, send_error = _run_handler(
            handle_tree_delete, {"path": "a.b"}, tree_with_comm
        )
        send_error.assert_not_called()
        assert "a.b" not in tree_with_comm
        assert "a" in tree_with_comm

    def test_delete_rejects_missing_path(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_delete

        send_message, send_error = _run_handler(
            handle_tree_delete, {"path": "ghost"}, tree_with_comm
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.path_not_found"
        send_message.assert_not_called()


class TestRename:
    """rename handler: re-key under the same parent, plus guards."""

    def test_rename_simple(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_rename

        tree_with_comm["old"] = 42
        send_message, send_error = _run_handler(
            handle_tree_rename, {"path": "old", "new_name": "new"}, tree_with_comm
        )
        send_error.assert_not_called()
        assert tree_with_comm["new"] == 42
        assert "old" not in tree_with_comm

    def test_rename_preserves_subtree(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_rename

        tree_with_comm["a.b.c"] = 99
        send_message, send_error = _run_handler(
            handle_tree_rename, {"path": "a.b", "new_name": "renamed"}, tree_with_comm
        )
        send_error.assert_not_called()
        assert tree_with_comm["a.renamed.c"] == 99
        assert "a.b" not in tree_with_comm

    def test_rename_rejects_duplicate(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_rename

        tree_with_comm["a"] = 1
        tree_with_comm["b"] = 2
        send_message, send_error = _run_handler(
            handle_tree_rename, {"path": "a", "new_name": "b"}, tree_with_comm
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.already_exists"
        send_message.assert_not_called()
        assert tree_with_comm["a"] == 1

    def test_rename_rejects_missing_path(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_rename

        send_message, send_error = _run_handler(
            handle_tree_rename, {"path": "ghost", "new_name": "x"}, tree_with_comm
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.path_not_found"

    def test_rename_rejects_dotted_name(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_rename

        tree_with_comm["node"] = 1
        send_message, send_error = _run_handler(
            handle_tree_rename, {"path": "node", "new_name": "a.b"}, tree_with_comm
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.invalid_name"
        send_message.assert_not_called()


class TestMove:
    """move handler: re-parent a node, plus circular/duplicate guards."""

    def test_move_simple(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_move

        tree_with_comm["source"] = 42
        tree_with_comm["dest_parent"] = PDVTree()
        send_message, send_error = _run_handler(
            handle_tree_move,
            {"path": "source", "new_path": "dest_parent.moved"},
            tree_with_comm,
        )
        send_error.assert_not_called()
        assert tree_with_comm["dest_parent.moved"] == 42
        assert "source" not in tree_with_comm

    def test_move_subtree(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_move

        tree_with_comm["a.b.c"] = "deep"
        tree_with_comm["target"] = PDVTree()
        send_message, send_error = _run_handler(
            handle_tree_move,
            {"path": "a", "new_path": "target.a_moved"},
            tree_with_comm,
        )
        send_error.assert_not_called()
        assert tree_with_comm["target.a_moved.b.c"] == "deep"
        assert "a" not in tree_with_comm

    def test_circular_move_rejected(self, tree_with_comm):
        # Moving a node into its own subtree must be refused by the handler,
        # not just by a string check in the test.
        from pdv.handlers.tree import handle_tree_move

        tree_with_comm["a.b.c"] = 1
        send_message, send_error = _run_handler(
            handle_tree_move,
            {"path": "a.b", "new_path": "a.b.c.inside"},
            tree_with_comm,
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.circular_move"
        send_message.assert_not_called()
        assert tree_with_comm["a.b.c"] == 1

    def test_move_rejects_same_path(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_move

        tree_with_comm["x"] = 1
        send_message, send_error = _run_handler(
            handle_tree_move, {"path": "x", "new_path": "x"}, tree_with_comm
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.same_path"
        send_message.assert_not_called()


class TestDuplicate:
    """duplicate handler: deep-copy a node, plus the duplicate-path guard."""

    def test_duplicate_value_is_independent(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_duplicate

        tree_with_comm["original"] = [1, 2, 3]
        send_message, send_error = _run_handler(
            handle_tree_duplicate,
            {"path": "original", "new_path": "clone"},
            tree_with_comm,
        )
        send_error.assert_not_called()
        assert tree_with_comm["clone"] == [1, 2, 3]
        # Mutating the original must not touch the deep copy.
        tree_with_comm["original"].append(4)
        assert tree_with_comm["clone"] == [1, 2, 3]

    def test_duplicate_subtree(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_duplicate

        tree_with_comm["a.b"] = 42
        tree_with_comm["a.c"] = [1, 2]
        send_message, send_error = _run_handler(
            handle_tree_duplicate,
            {"path": "a", "new_path": "a_copy"},
            tree_with_comm,
        )
        send_error.assert_not_called()
        assert tree_with_comm["a_copy.b"] == 42
        assert tree_with_comm["a_copy.c"] == [1, 2]

    def test_duplicate_rejects_existing(self, tree_with_comm):
        from pdv.handlers.tree import handle_tree_duplicate

        tree_with_comm["src"] = 1
        tree_with_comm["dst"] = 2
        send_message, send_error = _run_handler(
            handle_tree_duplicate,
            {"path": "src", "new_path": "dst"},
            tree_with_comm,
        )
        send_error.assert_called_once()
        assert send_error.call_args[0][1] == "tree.already_exists"
        send_message.assert_not_called()


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
