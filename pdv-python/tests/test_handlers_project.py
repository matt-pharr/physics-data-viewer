"""
pdv-python/tests/test_handlers_project.py — Tests for project save/load handlers.

Tests cover:
1. pdv.project.load: reads tree-index.json, builds tree.
2. pdv.project.load: nonexistent save_dir sends error.
3. pdv.project.load: pushes pdv.project.loaded notification.
4. pdv.project.save: writes tree-index.json, writes data files.
5. pdv.project.save: response includes node_count and checksum.
6. Two-pass loading: containers created before leaves regardless of order.
7. Metadata round-trips for module, gui, namelist, lib nodes.

Reference: ARCHITECTURE.md §4.2, §8
"""

import json
import os
import uuid
import pytest
from unittest.mock import MagicMock, patch
import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.project import handle_project_load, handle_project_save
from pdv_kernel.tree import PDVTree, PDVScript, PDVModule, PDVGui, PDVNamelist, PDVLib, PDVNote


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
                'storage': {'backend': 'none', 'format': 'none'},
                'metadata': {'preview': 'folder'},
            },
            {
                'path': 'data.x',
                'type': 'scalar',
                'storage': {'backend': 'inline', 'format': 'inline', 'value': 42},
                'metadata': {'preview': '42'},
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

    def test_file_backed_nodes_eagerly_loaded(self, tree_with_comm, tmp_save_dir):
        """File-backed nodes from tree-index.json are eagerly deserialized into the tree."""
        numpy = pytest.importorskip('numpy')
        arr = numpy.array([1.0, 2.0, 3.0])
        tree_dir = os.path.join(tree_with_comm._working_dir, 'tree')
        os.makedirs(tree_dir, exist_ok=True)
        numpy.save(os.path.join(tree_dir, 'arr.npy'), arr)
        nodes = [
            {
                'path': 'arr',
                'type': 'ndarray',
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
        assert numpy.array_equal(dict.__getitem__(tree_with_comm, 'arr'), arr)

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
        # Create file in working dir (TypeScript copies before load)
        working_dir = tree_with_comm._working_dir
        script_rel = os.path.join('tree', 'scripts', 'demo.py')
        script_file = os.path.join(working_dir, script_rel)
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, 'w', encoding='utf-8') as fh:
            fh.write('def run(pdv_tree: dict):\n    return {}\n')

        nodes = [
            {
                'path': 'scripts',
                'type': 'folder',
                'storage': {'backend': 'none', 'format': 'none'},
                'metadata': {'preview': 'folder'},
            },
            {
                'path': 'scripts.demo',
                'type': 'script',
                'storage': {
                    'backend': 'local_file',
                    'relative_path': script_rel,
                    'format': 'py_script',
                },
                'metadata': {'language': 'python', 'doc': None, 'preview': 'script'},
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

    def test_save_produces_metadata_subdicts(self, tree_with_comm, tmp_save_dir):
        """After saving, tree-index.json nodes have metadata sub-dicts."""
        tree_with_comm['x'] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg)
        with open(os.path.join(tmp_save_dir, 'tree-index.json')) as f:
            nodes = json.load(f)
        for node in nodes:
            assert 'metadata' in node, f"Missing metadata for {node['path']}"
            assert 'preview' in node['metadata']


class TestTwoPassLoading:
    """Tests for two-pass load ordering and metadata preservation."""

    def test_child_before_parent_gui(self, tree_with_comm, tmp_save_dir):
        """GUI node listed before its module parent still loads correctly."""
        working_dir = tree_with_comm._working_dir
        gui_rel = os.path.join('tree', 'mymod', 'gui.gui.json')
        gui_file = os.path.join(working_dir, gui_rel)
        os.makedirs(os.path.dirname(gui_file), exist_ok=True)
        with open(gui_file, 'w') as f:
            f.write('{}')

        # Intentionally put gui node BEFORE its module parent
        nodes = [
            {
                'path': 'mymod.gui',
                'type': 'gui',
                'storage': {'backend': 'local_file', 'relative_path': gui_rel, 'format': 'gui_json'},
                'metadata': {'module_id': 'test_mod', 'preview': 'GUI'},
            },
            {
                'path': 'mymod',
                'type': 'module',
                'has_children': True,
                'storage': {'backend': 'inline', 'format': 'module_meta', 'value': {
                    'module_id': 'test_mod', 'name': 'Test', 'version': '1.0',
                }},
                'metadata': {'module_id': 'test_mod', 'name': 'Test', 'version': '1.0', 'preview': 'Test v1.0'},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        assert isinstance(tree_with_comm['mymod'], PDVModule)
        assert isinstance(tree_with_comm['mymod.gui'], PDVGui)
        # GUI should be attached to the module
        assert tree_with_comm['mymod'].gui is tree_with_comm['mymod.gui']

    def test_module_metadata_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Module metadata (module_id, name, version) survives save→load."""
        mod = PDVModule(module_id='roundtrip_mod', name='Roundtrip', version='2.5.0')
        tree_with_comm['mod'] = mod
        mock_comm = _make_mock_comm()
        msg_save = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg_save)

        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(tree_with_comm._working_dir)
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm2), \
             patch.object(comms_mod, '_pdv_tree', fresh_tree):
            handle_project_load(msg_load)
        loaded_mod = fresh_tree['mod']
        assert isinstance(loaded_mod, PDVModule)
        assert loaded_mod.module_id == 'roundtrip_mod'
        assert loaded_mod.name == 'Roundtrip'
        assert loaded_mod.version == '2.5.0'

    def test_gui_module_id_roundtrip(self, tree_with_comm, tmp_save_dir):
        """GUI module_id survives save→load."""
        from pdv_kernel.tree import PDVModule, PDVGui
        mod = PDVModule(module_id='gui_mod', name='GuiMod', version='1.0')
        tree_with_comm['gmod'] = mod
        gui_rel = os.path.join('tree', 'gmod', 'gui.gui.json')
        gui_file = os.path.join(tree_with_comm._working_dir, gui_rel)
        os.makedirs(os.path.dirname(gui_file), exist_ok=True)
        with open(gui_file, 'w') as f:
            f.write('{"layout": {}}')
        gui = PDVGui(relative_path=gui_file, module_id='gui_mod')
        dict.__setitem__(mod, 'gui', gui)
        mod.gui = gui

        mock_comm = _make_mock_comm()
        msg_save = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg_save)

        # Verify metadata in tree-index.json
        with open(os.path.join(tmp_save_dir, 'tree-index.json')) as f:
            nodes = json.load(f)
        gui_nodes = [n for n in nodes if n['type'] == 'gui']
        assert len(gui_nodes) == 1
        assert gui_nodes[0]['metadata']['module_id'] == 'gui_mod'

    def test_namelist_format_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Namelist format and module_id survive save→load."""
        nml_rel = os.path.join('tree', 'solver.nml')
        nml_file = os.path.join(tree_with_comm._working_dir, nml_rel)
        os.makedirs(os.path.dirname(nml_file), exist_ok=True)
        with open(nml_file, 'w') as f:
            f.write('&solver /\n')
        nml = PDVNamelist(relative_path=nml_file, format='fortran', module_id='nml_mod')
        tree_with_comm['solver'] = nml

        mock_comm = _make_mock_comm()
        msg_save = _make_msg('pdv.project.save', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_save(msg_save)

        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(tree_with_comm._working_dir)
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm2), \
             patch.object(comms_mod, '_pdv_tree', fresh_tree):
            handle_project_load(msg_load)
        loaded = fresh_tree['solver']
        assert isinstance(loaded, PDVNamelist)
        assert loaded.format == 'fortran'
        assert loaded.module_id == 'nml_mod'

    def test_relative_paths_stored(self, tree_with_comm, tmp_save_dir):
        """After load, PDVFile nodes store relative (not absolute) paths."""
        working_dir = tree_with_comm._working_dir
        script_rel = os.path.join('tree', 'demo.py')
        script_file = os.path.join(working_dir, script_rel)
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, 'w') as f:
            f.write('def run(pdv_tree: dict):\n    return {}\n')

        nodes = [
            {
                'path': 'demo',
                'type': 'script',
                'storage': {'backend': 'local_file', 'relative_path': script_rel, 'format': 'py_script'},
                'metadata': {'language': 'python', 'preview': 'script'},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        script = tree_with_comm['demo']
        assert isinstance(script, PDVScript)
        assert not os.path.isabs(script.relative_path)
        assert script.relative_path == script_rel

    def test_module_working_dir_propagated(self, tree_with_comm, tmp_save_dir):
        """After load, PDVModule subtree nodes share the root working dir."""
        nodes = [
            {
                'path': 'mymod',
                'type': 'module',
                'has_children': True,
                'storage': {'backend': 'inline', 'format': 'module_meta', 'value': {
                    'module_id': 'prop_test', 'name': 'PropTest', 'version': '1.0',
                }},
                'metadata': {'module_id': 'prop_test', 'name': 'PropTest', 'version': '1.0', 'preview': ''},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg('pdv.project.load', {'save_dir': tmp_save_dir})
        with patch.object(comms_mod, '_comm', mock_comm), \
             patch.object(comms_mod, '_pdv_tree', tree_with_comm):
            handle_project_load(msg)
        mod = tree_with_comm['mymod']
        assert isinstance(mod, PDVModule)
        assert mod._working_dir == tree_with_comm._working_dir
