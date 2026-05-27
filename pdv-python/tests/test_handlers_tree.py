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

import pytest

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
        node_uuid = "scr_uuid_001"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "fit_model.py"
        script_file.write_text(
            "def run(pdv_tree: dict, sigma: float = 0.1):\n    return {}\n"
        )
        tree_with_comm._set_working_dir(str(tmp_path))
        tree_with_comm["script_node"] = PDVScript(uuid=node_uuid, filename="fit_model.py")
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

    def test_list_value_marks_has_children(self, tree_with_comm):
        """Non-empty list/tuple values report has_children so the renderer
        shows a disclosure chevron."""
        tree_with_comm["xs"] = [10, 20, 30]
        tree_with_comm["empty"] = []
        tree_with_comm["pair"] = (1, 2)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        nodes = {n["key"]: n for n in mock_comm._sent[0]["payload"]["nodes"]}
        assert nodes["xs"]["type"] == "sequence"
        assert nodes["xs"]["has_children"] is True
        assert nodes["pair"]["has_children"] is True
        assert nodes["empty"]["has_children"] is False

    def test_list_container_enumerates_indexed_children(self, tree_with_comm):
        """pdv.tree.list at a list path returns one child per element with
        stringified-int keys and the parent_is_opaque flag set."""
        tree_with_comm["xs"] = ["a", "b", "c"]
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "xs"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        nodes = response["payload"]["nodes"]
        assert [n["key"] for n in nodes] == ["0", "1", "2"]
        assert [n["path"] for n in nodes] == ["xs.0", "xs.1", "xs.2"]
        assert all(n["parent_is_opaque"] is True for n in nodes)

    def test_dict_children_are_not_indexed(self, tree_with_comm):
        """Children of a dict parent never carry parent_is_opaque."""
        tree_with_comm["data.x"] = 1
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "data"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        nodes = mock_comm._sent[0]["payload"]["nodes"]
        for node in nodes:
            assert "parent_is_opaque" not in node

    def test_nested_list_in_list(self, tree_with_comm):
        """A list containing dicts/lists is recursively expandable."""
        tree_with_comm["records"] = [{"name": "a", "v": 1}, [10, 20]]
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "records"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        nodes = mock_comm._sent[0]["payload"]["nodes"]
        by_key = {n["key"]: n for n in nodes}
        assert by_key["0"]["type"] == "mapping"
        assert by_key["0"]["has_children"] is True
        assert by_key["1"]["type"] == "sequence"
        assert by_key["1"]["has_children"] is True

    def test_dataset_value_marks_has_children(self, tree_with_comm):
        """Non-empty xarray.Dataset values report has_children so the
        renderer shows a disclosure chevron."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        tree_with_comm["ds"] = xr.Dataset(
            {"a": (("x",), np.array([1, 2, 3]))},
            coords={"x": [0, 1, 2]},
        )
        tree_with_comm["empty_ds"] = xr.Dataset(coords={"x": [0, 1]})
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        nodes = {n["key"]: n for n in mock_comm._sent[0]["payload"]["nodes"]}
        assert nodes["ds"]["type"] == "dataset"
        assert nodes["ds"]["has_children"] is True
        assert nodes["ds"]["preview"] == "1 vars"
        assert nodes["empty_ds"]["has_children"] is False

    def test_dataset_lists_data_vars_only(self, tree_with_comm):
        """pdv.tree.list at a Dataset path returns one child per data
        variable in insertion order; coords are intentionally excluded."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        tree_with_comm["ds"] = xr.Dataset(
            {
                "a": (("x",), np.array([1, 2, 3])),
                "b": (("x", "y"), np.zeros((3, 4))),
            },
            coords={"x": [0, 1, 2]},
        )
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "ds"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        nodes = response["payload"]["nodes"]
        assert [n["key"] for n in nodes] == ["a", "b"]
        assert all(n["type"] == "dataarray" for n in nodes)
        assert all(n["parent_is_opaque"] is True for n in nodes)
        assert all(n["has_children"] is False for n in nodes)
        assert nodes[0]["preview"] == "x: 3"
        assert nodes[1]["preview"] == "x: 3, y: 4"

    def test_dataarray_path_is_not_a_folder(self, tree_with_comm):
        """A DataArray inside a Dataset is a leaf — pdv.tree.list at its
        path errors with tree.not_a_folder."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        tree_with_comm["ds"] = xr.Dataset(
            {"a": (("x",), np.array([1, 2, 3]))}
        )
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "ds.a"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert "not_a_folder" in response["payload"]["code"]

    def test_dataarray_inside_list(self, tree_with_comm):
        """A DataArray held inside a regular list is detected and
        previewed with dim sizes — confirms detect_kind picks it up
        without extra wiring in the sequence path."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        tree_with_comm["arrs"] = [
            xr.DataArray(np.zeros(5), dims=("t",)),
            xr.DataArray(np.zeros((2, 3)), dims=("a", "b")),
        ]
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": "arrs"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        nodes = mock_comm._sent[0]["payload"]["nodes"]
        assert [n["type"] for n in nodes] == ["dataarray", "dataarray"]
        assert nodes[0]["preview"] == "t: 5"
        assert nodes[1]["preview"] == "a: 2, b: 3"

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

    def test_pdv_handle_dunder_sets_has_handler_true(self, tree_with_comm):
        """A class defining only ``__pdv_handle__`` is reported as having a
        handler in the tree-list response, so the renderer enables double-click
        without requiring a ``@pdv.handle`` registration."""

        class _DunderHandled:
            def __pdv_handle__(self, path, pdv_tree):
                pass

        tree_with_comm["d"] = _DunderHandled()
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.list", {"path": ""})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_list(msg)
        node = mock_comm._sent[0]["payload"]["nodes"][0]
        assert node["has_handler"] is True


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

    def test_get_indexed_list_element(self, tree_with_comm):
        """pdv.tree.get resolves a numeric path segment as a list index."""
        tree_with_comm["xs"] = ["alpha", "beta", "gamma"]
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.get", {"path": "xs.1", "mode": "value"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_get(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        assert response["payload"]["path"] == "xs.1"
        assert "beta" in response["payload"]["value"]

    def test_get_indexed_path_into_dict_inside_list(self, tree_with_comm):
        """Dot-paths descend through list indices into nested dicts."""
        tree_with_comm["records"] = [{"name": "a"}, {"name": "b"}]
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.get", {"path": "records.1.name", "mode": "value"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_tree_get(msg)
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        assert "b" in response["payload"]["value"]

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
