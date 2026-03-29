"""
pdv-python/tests/test_serialization_errors.py — Error-path tests for deserialization.
"""

import os
import pickle

import pytest

from pdv_kernel.errors import PDVSerializationError
from pdv_kernel.serialization import deserialize_node


def test_missing_file_raises_descriptive_error(tmp_save_dir):
    with pytest.raises(FileNotFoundError, match='Backing file not found'):
        deserialize_node(
            {
                'backend': 'local_file',
                'relative_path': 'tree/missing_arr.npy',
                'format': 'npy',
            },
            tmp_save_dir,
        )


def test_corrupted_npy_raises_descriptive_error(tmp_save_dir):
    tree_dir = os.path.join(tmp_save_dir, 'tree')
    os.makedirs(tree_dir, exist_ok=True)
    bad_file = os.path.join(tree_dir, 'bad.npy')
    with open(bad_file, 'wb') as fh:
        fh.write(b'not-a-valid-npy')

    with pytest.raises(Exception) as exc_info:  # numpy raises ValueError/OSError by version
        deserialize_node(
            {
                'backend': 'local_file',
                'relative_path': 'tree/bad.npy',
                'format': 'npy',
            },
            tmp_save_dir,
        )
    assert str(exc_info.value)


def test_wrong_format_hint_raises_error(tmp_save_dir):
    tree_dir = os.path.join(tmp_save_dir, 'tree')
    os.makedirs(tree_dir, exist_ok=True)
    file_path = os.path.join(tree_dir, 'x.bin')
    with open(file_path, 'wb') as fh:
        fh.write(b'abc')

    with pytest.raises(PDVSerializationError, match='Unsupported storage format'):
        deserialize_node(
            {
                'backend': 'local_file',
                'relative_path': 'tree/x.bin',
                'format': 'made-up-format',
            },
            tmp_save_dir,
        )


def test_deserialize_pickle_without_trusted_raises(tmp_save_dir):
    tree_dir = os.path.join(tmp_save_dir, 'tree')
    os.makedirs(tree_dir, exist_ok=True)
    file_path = os.path.join(tree_dir, 'unsafe.pickle')
    with open(file_path, 'wb') as fh:
        pickle.dump({'k': 'v'}, fh)

    with pytest.raises(PDVSerializationError, match='Pickle deserialization is disabled'):
        deserialize_node(
            {
                'backend': 'local_file',
                'relative_path': 'tree/unsafe.pickle',
                'format': 'pickle',
            },
            tmp_save_dir,
            trusted=False,
        )
