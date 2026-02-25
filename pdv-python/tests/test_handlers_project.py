"""
pdv-python/tests/test_handlers_project.py — Tests for project save/load handlers.

Tests cover:
1. pdv.project.load: reads tree-index.json, populates lazy registry, builds tree.
2. pdv.project.load: nonexistent save_dir sends error.
3. pdv.project.load: pushes pdv.project.loaded notification.
4. pdv.project.save: writes tree-index.json, writes data files.
5. pdv.project.save: response includes node_count and checksum.

Reference: ARCHITECTURE.md §4.2, §8
"""

import json
import os
import uuid
import pytest
from unittest.mock import MagicMock, patch
import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.project import handle_project_load, handle_project_save
from pdv_kernel.tree import PDVTree, PDVScript


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(msg_type, payload, msg_id=None):
    return {
        'pdv_version': comms_mod.PDV_PROTOCOL_VERSION,
        'msg_id': msg_id or str(uuid.uuid4()),
        'in_reply_to': None,
        'type': msg_type,
        'payload': payload,
    }


def _write_tree_index(save_dir, nodes):
    with open(os.path.join(save_dir, 'tree-index.json'), 'w') as f:
        json.dump(nodes, f)


class TestHandleProjectLoad:
    def test_loads_tree_from_index(self, tree_with_comm, tmp_save_dir):
        """handle_project_load() reads tree-index.json and builds the tree skeleton."""
        nodes = [
            {
                'path': 'data',
                'type': 'folder',
                'lazy': False,
                'storage': {'backend': 'none', 'format': 'none'},
            },
            {
                'path': 'data.x',
                'type': 'scalar',
                'lazy': False,
                'storage': {'backend': 'inline', 'format': 'inline', 'value': 42},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        # Inline value should be accessible
        assert tree_with_comm['data.x'] == 42

    def test_lazy_nodes_registered(self, tree_with_comm, tmp_save_dir):
        """Lazy nodes from tree-index.json are registered in the lazy-load registry."""
        nodes = [
            {
                'path': 'arr',
                'type': 'ndarray',
                'lazy': True,
                'storage': {
                    'backend': 'local_file',
                    'relative_path': 'tree/arr.npy',
                    'format': 'npy',
                },
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        assert tree_with_comm._lazy_registry.has('arr')

    def test_sends_project_loaded_push(self, tree_with_comm, tmp_save_dir):
        """After loading, pdv.project.loaded push notification is sent."""
        _write_tree_index(tmp_save_dir, [])
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        types_sent = [e['type'] for e in mock_comm._sent]
        assert 'pdv.project.load.response' in types_sent
        assert 'pdv.project.loaded' in types_sent

    def test_script_nodes_restore_as_pdvscript(self, tree_with_comm, tmp_save_dir):
        """Script descriptors are restored as PDVScript instances, not plain text."""
        script_file = os.path.join(tmp_save_dir, 'tree', 'scripts', 'demo.py')
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, 'w', encoding='utf-8') as fh:
            fh.write('def run(pdv_tree: dict):\n    return {}\n')

        nodes = [
            {
                'path': 'scripts',
                'type': 'folder',
                'lazy': False,
                'storage': {'backend': 'none', 'format': 'none'},
            },
            {
                'path': 'scripts.demo',
                'type': 'script',
                'lazy': False,
                'language': 'python',
                'storage': {'backend': 'inline', 'format': 'py_script', 'value': script_file},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        assert isinstance(tree_with_comm['scripts.demo'], PDVScript)

    def test_nonexistent_save_dir_sends_error(self, tree_with_comm):
        """A non-existent save_dir sends status=error response."""
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': '/no/such/directory'})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        assert len(mock_comm._sent) == 1
        envelope = mock_comm._sent[0]
        assert envelope['status'] == 'error'


class TestHandleProjectSave:
    def test_writes_tree_index(self, tree_with_comm, tmp_save_dir):
        """handle_project_save() writes tree-index.json to the save directory."""
        tree_with_comm['x'] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg)
        index_path = os.path.join(tmp_save_dir, 'tree-index.json')
        assert os.path.exists(index_path)
        with open(index_path) as f:
            nodes = json.load(f)
        assert isinstance(nodes, list)

    def test_writes_data_files(self, tree_with_comm, tmp_save_dir):
        """Data files are written for each serializable node."""
        numpy = pytest.importorskip('numpy')
        tree_with_comm['arr'] = numpy.array([1.0, 2.0, 3.0])
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg)
        # The .npy file should exist somewhere under tmp_save_dir/tree/
        npy_files = []
        for root, _, files in os.walk(tmp_save_dir):
            for f in files:
                if f.endswith('.npy'):
                    npy_files.append(f)
        assert len(npy_files) > 0

    def test_response_has_node_count(self, tree_with_comm, tmp_save_dir):
        """Response payload includes node_count."""
        tree_with_comm['a'] = 1
        tree_with_comm['b'] = 2
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg)
        response = mock_comm._sent[-1]
        assert response['type'] == 'pdv.project.save.response'
        assert response['status'] == 'ok'
        assert 'node_count' in response['payload']
        assert response['payload']['node_count'] >= 2

    def test_response_has_checksum(self, tree_with_comm, tmp_save_dir):
        """Response payload includes checksum of tree-index.json."""
        tree_with_comm['c'] = 3
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg)
        response = mock_comm._sent[-1]
        assert 'checksum' in response['payload']
        assert len(response['payload']['checksum']) == 64  # SHA-256 hex

    def test_save_load_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Save then load produces an isomorphic tree."""
        tree_with_comm['score'] = 99
        mock_comm = _make_mock_comm()
        msg_save = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg_save)

        # Now load into a fresh tree
        fresh_tree = PDVTree()
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm2), \
             patch.object(comms_mod, '_pdv_tree', fresh_tree):
            handle_project_load(msg_load)

        assert fresh_tree['score'] == 99
