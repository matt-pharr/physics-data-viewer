"""
pdv-python/tests/test_pdv_hdf5.py — Tests for the PDVHdf5 node type.

Tests cover:
1. detect_kind / serialize_node / load_tree_index round-trip.
2. Lazy open, slash-path access, close/retry, pickle dropping the handle.
3. Tree listing: nested group hierarchy served as virtual children at
   arbitrary depth (hdf5_group / hdf5_dataset kinds, previews).
4. Dot-path descent through groups to datasets.
5. Graceful failure: missing h5py and corrupt files degrade to messages.

Reference: ARCHITECTURE.md §7.2, issue #203
"""

import os
import pickle
import uuid
from unittest.mock import patch

import pytest

import pdv.comms as comms_mod
from pdv.errors import PDVError
from pdv.handlers.tree import handle_tree_list
from pdv.serialization import (
    FORMAT_HDF5,
    KIND_HDF5_DATASET,
    KIND_HDF5_FILE,
    KIND_HDF5_GROUP,
    detect_kind,
    serialize_node,
)
from pdv.tree import PDVHdf5, PDVTree
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


NODE_UUID = "def456abc123"


def _write_h5(working_dir: str, node_uuid: str = NODE_UUID,
              filename: str = "efit.h5") -> str:
    """Write a nested HDF5 file into UUID storage; return its path."""
    h5py = pytest.importorskip("h5py")
    import numpy as np

    dest_dir = os.path.join(working_dir, "tree", node_uuid)
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, filename)
    with h5py.File(path, "w") as f:
        f.create_dataset("t0", data=np.float64(1.5))
        f.attrs["shot"] = 12345
        grp = f.create_group("profiles")
        grp.create_dataset("pressure", data=np.zeros((2, 3)))
        sub = grp.create_group("fits")
        sub.create_dataset("psi", data=np.arange(4.0))
    return path


@pytest.fixture()
def h5_node(tree_with_comm):
    """A PDVHdf5 with a real backing file, attached at tree['efit.data']."""
    _write_h5(tree_with_comm._working_dir)
    node = PDVHdf5(uuid=NODE_UUID, filename="efit.h5")
    tree_with_comm.set_quiet("efit.data", node)
    with patch.object(comms_mod, "_pdv_tree", tree_with_comm):
        yield tree_with_comm, node
    node.close()


class TestDetectKindAndSerialize:
    def test_detect_kind(self):
        node = PDVHdf5(uuid=NODE_UUID, filename="efit.h5")
        assert detect_kind(node) == KIND_HDF5_FILE

    def test_serialize_descriptor(self, tmp_path):
        _write_h5(str(tmp_path))
        node = PDVHdf5(uuid=NODE_UUID, filename="efit.h5")
        descriptor = serialize_node("efit.data", node, str(tmp_path))
        assert descriptor["type"] == KIND_HDF5_FILE
        assert descriptor["storage"]["backend"] == "local_file"
        assert descriptor["storage"]["format"] == FORMAT_HDF5
        assert descriptor["storage"]["uuid"] == NODE_UUID
        assert set(descriptor["metadata"].keys()) == {"preview"}

    def test_load_tree_index_reconstructs_lazily(self, tmp_path):
        _write_h5(str(tmp_path))
        node = PDVHdf5(uuid=NODE_UUID, filename="efit.h5")
        descriptor = serialize_node("efit.data", node, str(tmp_path))
        parent = serialize_node("efit", {"data": node}, str(tmp_path))

        tree2 = PDVTree()
        tree2._set_working_dir(str(tmp_path))
        skipped = load_tree_index(
            tree2, [parent, descriptor], working_dir=str(tmp_path)
        )
        assert skipped == []
        loaded = tree2["efit.data"]
        assert isinstance(loaded, PDVHdf5)
        assert loaded._handle is None


class TestLazyOpenAndAccess:
    def test_slash_and_dot_paths_agree(self, h5_node):
        tree, node = h5_node
        assert node._handle is None
        assert node["profiles/pressure"].shape == (2, 3)
        assert tree["efit.data.profiles.pressure"].shape == (2, 3)
        assert tree["efit.data.profiles.fits.psi"][()].tolist() == [
            0.0, 1.0, 2.0, 3.0,
        ]
        assert node._handle is not None

    def test_keys_attrs_preview(self, h5_node):
        _tree, node = h5_node
        assert sorted(node.keys()) == ["profiles", "t0"]
        assert node.attrs["shot"] == 12345
        assert node.preview() == "efit.h5 — 2 items"

    def test_close_allows_reopen(self, h5_node):
        _tree, node = h5_node
        node.open()
        node.close()
        assert node._handle is None
        assert sorted(node.keys()) == ["profiles", "t0"]

    def test_pickle_drops_handle(self, h5_node):
        _tree, node = h5_node
        node.open()
        restored = pickle.loads(pickle.dumps(node))
        assert isinstance(restored, PDVHdf5)
        assert restored._handle is None


class TestTreeListNestedHierarchy:
    def test_root_level_children(self, h5_node):
        tree, _node = h5_node
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            handle_tree_list(_make_msg("pdv.tree.list", {"path": "efit.data"}))
        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        nodes = {n["key"]: n for n in response["payload"]["nodes"]}
        assert nodes["profiles"]["type"] == KIND_HDF5_GROUP
        assert nodes["profiles"]["has_children"] is True
        assert nodes["profiles"]["preview"] == "group (2 items)"
        assert nodes["t0"]["type"] == KIND_HDF5_DATASET
        assert nodes["t0"]["has_children"] is False
        assert all(
            n["parent_is_opaque"] is True
            for n in response["payload"]["nodes"]
        )

    def test_arbitrary_depth_expansion(self, h5_node):
        tree, _node = h5_node
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            handle_tree_list(
                _make_msg("pdv.tree.list", {"path": "efit.data.profiles"})
            )
        nodes = {n["key"]: n for n in mock_comm._sent[0]["payload"]["nodes"]}
        assert nodes["pressure"]["type"] == KIND_HDF5_DATASET
        assert nodes["pressure"]["preview"] == "float64 (2 × 3)"
        assert nodes["fits"]["type"] == KIND_HDF5_GROUP
        assert nodes["fits"]["has_children"] is True

    def test_h5_dataset_row_is_leaf_folder_error(self, h5_node):
        tree, _node = h5_node
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            handle_tree_list(
                _make_msg("pdv.tree.list", {"path": "efit.data.t0"})
            )
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert "not_a_folder" in response["payload"]["code"]


class TestGracefulFailure:
    def test_missing_deps_error_message(self):
        node = PDVHdf5(uuid=NODE_UUID, filename="efit.h5")
        with patch.object(PDVHdf5, "_missing_deps", return_value=["h5py"]):
            with pytest.raises(PDVError) as excinfo:
                node.open()
            message = str(excinfo.value)
            assert "pdv.install('h5py')" in message
            assert "pdv-python[hdf5]" in message
            assert node.preview() == "requires h5py"
            assert node.__pdv_has_children__() is False

    def test_corrupt_file_degrades(self, tree_with_comm):
        pytest.importorskip("h5py")
        node_uuid = "bad000000002"
        dest_dir = os.path.join(tree_with_comm._working_dir, "tree", node_uuid)
        os.makedirs(dest_dir)
        with open(os.path.join(dest_dir, "junk.h5"), "wb") as f:
            f.write(b"this is not an hdf5 file")
        node = PDVHdf5(uuid=node_uuid, filename="junk.h5")
        tree_with_comm.set_quiet("d", node)
        mock_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            with pytest.raises(PDVError):
                node.open()
            assert node.preview() == "junk.h5 (unreadable)"
            handle_tree_list(_make_msg("pdv.tree.list", {"path": "d"}))
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "tree.load_error"
