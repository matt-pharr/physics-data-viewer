"""
pdv-python/tests/test_handlers_tree.py — Tests for pdv.tree.list and pdv.tree.get handlers.

Tests cover:
1. pdv.tree.list at root returns top-level children.
2. pdv.tree.list at nested path returns correct children.
3. pdv.tree.list at invalid path sends error.
4. pdv.tree.get mode='metadata' returns descriptor without loading data.
5. pdv.tree.get mode='value' returns value.
6. pdv.tree.get at missing path sends error.

Reference: ARCHITECTURE.md §3.4, §7
"""

import uuid
from unittest.mock import MagicMock, patch
import pdv.comms as comms_mod
from pdv.handlers.tree import handle_tree_list, handle_tree_get
from pdv.tree import PDVScript


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(msg_type, payload, msg_id=None):
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": msg_id or str(uuid.uuid4()),
        "in_reply_to": None,
        "type": msg_type,
        "payload": payload,
    }


class TestHandleTreeList:
    def test_root_list(self, tree_with_comm):
        """pdv.tree.list at '' returns top-level children."""
        tree_with_comm["a"] = 1
        tree_with_comm["b"] = 2
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        assert response["type"] == "pdv.tree.list.response"
        assert response["status"] == "ok"
        nodes = response["payload"]["nodes"]
        keys = [n["key"] for n in nodes]
        assert "a" in keys
        assert "b" in keys

    def test_nested_list(self, tree_with_comm):
        """pdv.tree.list at 'data' returns children of the data subtree."""
        tree_with_comm["data.x"] = 1
        tree_with_comm["data.y"] = 2
        tree_with_comm["other"] = 3
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "data"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        nodes = response["payload"]["nodes"]
        keys = [n["key"] for n in nodes]
        assert "x" in keys
        assert "y" in keys
        assert "other" not in keys

    def test_list_missing_path_sends_error(self, tree_with_comm):
        """pdv.tree.list at a non-existent path sends status=error."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "nonexistent.path"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "error"

    def test_nodes_have_required_fields(self, tree_with_comm):
        """All returned node descriptors contain id, path, key, type fields."""
        tree_with_comm["item"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        for node in response["payload"]["nodes"]:
            assert "id" in node
            assert "path" in node
            assert "key" in node
            assert "type" in node

    def test_script_nodes_do_not_include_params(self, tree_with_comm, tmp_path):
        """Script node descriptors from tree.list do not include params (fetched on demand)."""
        script_file = tmp_path / "fit_model.py"
        script_file.write_text(
            "def run(pdv_tree: dict, sigma: float = 0.1):\n    return {}\n"
        )
        tree_with_comm["script_node"] = PDVScript(relative_path=str(script_file))
        tree_with_comm["value_node"] = 42

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)

        nodes = mock_comm._sent[0]["payload"]["nodes"]
        script_node = next(node for node in nodes if node["key"] == "script_node")
        value_node = next(node for node in nodes if node["key"] == "value_node")

        assert script_node["type"] == "script"
        assert "params" not in script_node
        assert "params" not in value_node

    def test_nodes_include_python_type_and_has_handler(self, tree_with_comm):
        """Node descriptors include python_type and has_handler fields."""
        tree_with_comm["val"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        node = response["payload"]["nodes"][0]
        assert "python_type" in node
        assert node["python_type"] == "builtins.int"
        assert "has_handler" in node
        assert node["has_handler"] is False


class TestHandleTreeGet:
    def test_metadata_mode_returns_kind(self, tree_with_comm):
        """mode='metadata' returns type info for an in-memory node."""
        tree_with_comm["meta_val"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.get", {"path": "meta_val", "mode": "metadata"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_get(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        assert response["payload"]["type"] == "scalar"

    def test_value_mode_returns_value(self, tree_with_comm):
        """mode='value' returns the node value."""
        tree_with_comm["ch1"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.get", {"path": "ch1", "mode": "value"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_get(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        assert response["payload"]["path"] == "ch1"

    def test_get_missing_path_sends_error(self, tree_with_comm):
        """pdv.tree.get for a non-existent path sends status=error."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.get", {"path": "totally.missing", "mode": "value"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_get(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert "path_not_found" in response["payload"]["code"]
