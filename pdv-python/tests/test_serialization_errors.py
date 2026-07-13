"""
pdv-python/tests/test_serialization_errors.py — Error-path tests for deserialization.
"""

import os
import pickle

import pytest

from pdv.errors import PDVSerializationError
from pdv.serialization import deserialize_node


def test_missing_file_raises_descriptive_error(tmp_save_dir):
    with pytest.raises(FileNotFoundError, match="Backing file not found"):
        deserialize_node(
            {
                "backend": "local_file",
                "uuid": "missing_uuid1",
                "filename": "missing_arr.npy",
                "format": "npy",
            },
            tmp_save_dir,
        )


def test_corrupted_npy_raises_descriptive_error(tmp_save_dir):
    node_uuid = "corrupt_uuid"
    tree_dir = os.path.join(tmp_save_dir, "tree", node_uuid)
    os.makedirs(tree_dir, exist_ok=True)
    bad_file = os.path.join(tree_dir, "bad.npy")
    # Valid npy magic + version, then a header length that overruns the file —
    # a genuinely corrupt array whose header parse fails. numpy raises a
    # ValueError mentioning the array header (stable wording across the
    # supported numpy floor 2.2.0 through current).
    with open(bad_file, "wb") as fh:
        fh.write(b"\x93NUMPY\x01\x00\x76\x00{garbage header not a dict")

    with pytest.raises(ValueError, match="array header"):
        deserialize_node(
            {
                "backend": "local_file",
                "uuid": node_uuid,
                "filename": "bad.npy",
                "format": "npy",
            },
            tmp_save_dir,
        )


def test_wrong_format_hint_raises_error(tmp_save_dir):
    node_uuid = "fmt_uuid_001"
    tree_dir = os.path.join(tmp_save_dir, "tree", node_uuid)
    os.makedirs(tree_dir, exist_ok=True)
    file_path = os.path.join(tree_dir, "x.bin")
    with open(file_path, "wb") as fh:
        fh.write(b"abc")

    with pytest.raises(PDVSerializationError, match="Unsupported storage format"):
        deserialize_node(
            {
                "backend": "local_file",
                "uuid": node_uuid,
                "filename": "x.bin",
                "format": "made-up-format",
            },
            tmp_save_dir,
        )


def test_deserialize_pickle_without_trusted_raises(tmp_save_dir):
    node_uuid = "pkl_uuid_001"
    tree_dir = os.path.join(tmp_save_dir, "tree", node_uuid)
    os.makedirs(tree_dir, exist_ok=True)
    file_path = os.path.join(tree_dir, "unsafe.pickle")
    with open(file_path, "wb") as fh:
        pickle.dump({"k": "v"}, fh)

    with pytest.raises(
        PDVSerializationError, match="Pickle deserialization is disabled"
    ):
        deserialize_node(
            {
                "backend": "local_file",
                "uuid": node_uuid,
                "filename": "unsafe.pickle",
                "format": "pickle",
            },
            tmp_save_dir,
            trusted=False,
        )
