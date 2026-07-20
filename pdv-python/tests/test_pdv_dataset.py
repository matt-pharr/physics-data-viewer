"""
pdv-python/tests/test_pdv_dataset.py — Tests for the PDVDataset node type.

Tests cover:
1. detect_kind / serialize_node / load_tree_index round-trip (file copied
   as-is, node reconstructed lazily).
2. Lazy open, cached handle, close/retry, pickle dropping the handle.
3. Python access: __getitem__, keys(), attrs, dot-path descent.
4. Tree listing: data_vars + coords virtual children with is_coord,
   parent_is_opaque, has_children.
5. Graceful failure: missing dependencies and corrupt files degrade to
   messages (tree.load_error / preview hints), never a crash.

Reference: ARCHITECTURE.md §7.2, issue #203
"""

import os
import pickle
import uuid
from unittest.mock import patch

import pytest

import pdv.comms as comms_mod
from pdv.errors import PDVError
from pdv.handlers.tree import handle_tree_get, handle_tree_list
from pdv.serialization import (
    FORMAT_NETCDF,
    KIND_DATASET_FILE,
    detect_kind,
    node_preview,
    serialize_node,
)
from pdv.tree import PDVDataset, PDVTree
from pdv.tree_loader import load_tree_index


def _make_mock_comm():
    from unittest.mock import MagicMock

    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(msg_type, payload):
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": str(uuid.uuid4()),
        "in_reply_to": None,
        "type": msg_type,
        "payload": payload,
    }


NODE_UUID = "abc123def456"


def _write_nc(working_dir: str, node_uuid: str = NODE_UUID,
              filename: str = "data.nc") -> str:
    """Write a tiny NetCDF file into UUID storage; return its path."""
    xr = pytest.importorskip("xarray")
    if PDVDataset._missing_deps():
        pytest.skip("no NetCDF backend engine installed")
    import numpy as np

    ds = xr.Dataset(
        {
            "phi": (("x",), np.array([1.0, 2.0, 3.0])),
            "psi": (("x", "y"), np.zeros((3, 2))),
        },
        coords={"x": [0, 1, 2], "y": [0.5, 1.5]},
    )
    dest_dir = os.path.join(working_dir, "tree", node_uuid)
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, filename)
    ds.to_netcdf(path)
    ds.close()
    return path


@pytest.fixture()
def nc_node(tree_with_comm):
    """A PDVDataset with a real backing file, attached at tree['gpec.out']."""
    _write_nc(tree_with_comm._working_dir)
    node = PDVDataset(uuid=NODE_UUID, filename="data.nc")
    tree_with_comm.set_quiet("gpec.out", node)
    with patch.object(comms_mod, "_pdv_tree", tree_with_comm):
        yield tree_with_comm, node
    node.close()


class TestDetectKindAndSerialize:
    def test_detect_kind(self):
        node = PDVDataset(uuid=NODE_UUID, filename="data.nc")
        assert detect_kind(node) == KIND_DATASET_FILE

    def test_serialize_descriptor(self, tmp_path):
        _write_nc(str(tmp_path))
        node = PDVDataset(uuid=NODE_UUID, filename="data.nc")
        descriptor = serialize_node("gpec.out", node, str(tmp_path))
        assert descriptor["type"] == KIND_DATASET_FILE
        assert descriptor["storage"]["backend"] == "local_file"
        assert descriptor["storage"]["format"] == FORMAT_NETCDF
        assert descriptor["storage"]["uuid"] == NODE_UUID
        assert descriptor["storage"]["filename"] == "data.nc"
        # No metadata caching: preview only, no shape/dtype/variable list.
        assert set(descriptor["metadata"].keys()) == {"preview"}

    def test_serialize_missing_file_raises(self, tmp_path):
        node = PDVDataset(uuid="dead12345678", filename="gone.nc")
        with pytest.raises(Exception):
            serialize_node("gpec.out", node, str(tmp_path))

    def test_load_tree_index_reconstructs_lazily(self, tmp_path):
        _write_nc(str(tmp_path))
        node = PDVDataset(uuid=NODE_UUID, filename="data.nc")
        descriptor = serialize_node("gpec.out", node, str(tmp_path))
        parent = serialize_node("gpec", {"out": node}, str(tmp_path))

        tree2 = PDVTree()
        tree2._set_working_dir(str(tmp_path))
        skipped = load_tree_index(
            tree2, [parent, descriptor], working_dir=str(tmp_path)
        )
        assert skipped == []
        loaded = tree2["gpec.out"]
        assert isinstance(loaded, PDVDataset)
        assert loaded.uuid == NODE_UUID
        # Reconstruction is lazy — no handle opened yet.
        assert loaded._ds is None


class TestLazyOpenAndAccess:
    def test_getitem_keys_attrs(self, nc_node):
        _tree, node = nc_node
        assert node._ds is None
        assert sorted(node.keys()) == ["phi", "psi", "x", "y"]
        assert node["phi"].shape == (3,)
        assert node["x"].values.tolist() == [0, 1, 2]
        assert isinstance(node.attrs, dict)
        assert node._ds is not None  # handle cached after first access

    def test_dot_path_descent(self, nc_node):
        tree, _node = nc_node
        assert tree["gpec.out.phi"].shape == (3,)
        assert tree["gpec.out.y"].values.tolist() == [0.5, 1.5]
        assert "gpec.out.phi" in tree
        assert "gpec.out.nope" not in tree

    def test_preview_counts(self, nc_node):
        _tree, node = nc_node
        assert node.preview() == "data.nc — 2 vars, 2 coords"
        assert node_preview(node, KIND_DATASET_FILE) == node.preview()

    def test_close_allows_reopen(self, nc_node):
        _tree, node = nc_node
        assert node["phi"].shape == (3,)
        node.close()
        assert node._ds is None
        assert node["psi"].shape == (3, 2)

    def test_pickle_drops_handle(self, nc_node):
        _tree, node = nc_node
        node.open()
        restored = pickle.loads(pickle.dumps(node))
        assert isinstance(restored, PDVDataset)
        assert restored.uuid == node.uuid
        assert restored._ds is None
        assert restored._open_error is None


class TestTreeListVirtualChildren:
    def test_node_row_reports_children(self, nc_node):
        tree, _node = nc_node
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            handle_tree_list(_make_msg("pdv.tree.list", {"path": "gpec"}))
        nodes = {n["key"]: n for n in mock_comm._sent[0]["payload"]["nodes"]}
        row = nodes["out"]
        assert row["type"] == KIND_DATASET_FILE
        assert row["has_children"] is True
        assert "2 vars" in row["preview"]

    def test_expansion_lists_vars_then_coords(self, nc_node):
        tree, _node = nc_node
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            handle_tree_list(_make_msg("pdv.tree.list", {"path": "gpec.out"}))
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        nodes = response["payload"]["nodes"]
        assert [n["key"] for n in nodes] == ["phi", "psi", "x", "y"]
        assert all(n["type"] == "dataarray" for n in nodes)
        assert all(n["parent_is_opaque"] is True for n in nodes)
        assert "is_coord" not in nodes[0]
        assert nodes[2]["is_coord"] is True
        assert nodes[3]["is_coord"] is True

    def test_tree_get_on_virtual_path(self, nc_node):
        tree, _node = nc_node
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            handle_tree_get(
                _make_msg("pdv.tree.get", {"path": "gpec.out.phi"})
            )
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        assert response["payload"]["type"] == "dataarray"


class TestGracefulFailure:
    def test_missing_deps_error_message(self):
        node = PDVDataset(uuid=NODE_UUID, filename="data.nc")
        with patch.object(
            PDVDataset, "_missing_deps", return_value=["xarray", "netcdf4"]
        ):
            with pytest.raises(PDVError) as excinfo:
                node.open()
            message = str(excinfo.value)
            assert "pdv.install('xarray', 'netcdf4')" in message
            assert "pdv-python[netcdf]" in message
            assert node.preview() == "requires xarray, netcdf4"
            assert node.__pdv_has_children__() is False

    def test_missing_deps_expansion_sends_load_error(self, tree_with_comm):
        node = PDVDataset(uuid=NODE_UUID, filename="data.nc")
        tree_with_comm.set_quiet("d", node)
        mock_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
            patch.object(
                PDVDataset, "_missing_deps", return_value=["xarray"]
            ),
        ):
            handle_tree_list(_make_msg("pdv.tree.list", {"path": "d"}))
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "tree.load_error"
        assert "xarray" in response["payload"]["message"]

    def test_corrupt_file_degrades(self, tree_with_comm):
        pytest.importorskip("xarray")
        if PDVDataset._missing_deps():
            pytest.skip("no NetCDF backend engine installed")
        node_uuid = "bad000000001"
        dest_dir = os.path.join(tree_with_comm._working_dir, "tree", node_uuid)
        os.makedirs(dest_dir)
        with open(os.path.join(dest_dir, "junk.nc"), "wb") as f:
            f.write(b"this is not a netcdf file")
        node = PDVDataset(uuid=node_uuid, filename="junk.nc")
        tree_with_comm.set_quiet("d", node)
        mock_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            with pytest.raises(PDVError):
                node.open()
            assert node.preview() == "junk.nc (unreadable)"
            assert node.__pdv_has_children__() is False
            handle_tree_list(_make_msg("pdv.tree.list", {"path": "d"}))
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "tree.load_error"

    def test_missing_backing_file(self, tree_with_comm):
        pytest.importorskip("xarray")
        if PDVDataset._missing_deps():
            pytest.skip("no NetCDF backend engine installed")
        node = PDVDataset(uuid="dead12345678", filename="gone.nc")
        tree_with_comm.set_quiet("d", node)
        with patch.object(comms_mod, "_pdv_tree", tree_with_comm):
            with pytest.raises(PDVError):
                node.open()
            assert node.preview() == "gone.nc (unreadable)"
