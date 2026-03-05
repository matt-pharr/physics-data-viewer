"""
pdv-python/tests/test_tree.py — Unit tests for PDVTree and PDVScript.

Tests are organized around three areas:

1. Dot-path access: set, get, delete, contains via nested paths.
2. Lazy loading: registry population, transparent fetch, cache eviction.
3. Change notification: mutations emit pdv.tree.changed with correct diff.

Reference: ARCHITECTURE.md §5.6, §5.7, §5.8, §7.1
"""

import os

import pytest
from pdv_kernel.tree import PDVTree, PDVScript, LazyLoadRegistry
from pdv_kernel.errors import PDVKeyError, PDVPathError, PDVScriptError


class TestDotPathAccess:
    """Tests for dot-path set/get/delete/contains."""

    def test_simple_set_and_get(self, tree_with_comm):
        """Setting and getting a simple key works."""
        tree_with_comm['x'] = 42
        assert tree_with_comm['x'] == 42

    def test_nested_set_creates_intermediate_nodes(self, tree_with_comm):
        """Setting 'a.b.c' = 1 creates intermediate PDVTree nodes."""
        tree_with_comm['a.b.c'] = 1
        assert isinstance(tree_with_comm['a'], PDVTree)
        assert isinstance(tree_with_comm['a']['b'], PDVTree)

    def test_nested_get(self, tree_with_comm):
        """Getting a nested path after set returns the correct value."""
        tree_with_comm['a.b.c'] = 99
        assert tree_with_comm['a.b.c'] == 99

    def test_contains_simple(self, tree_with_comm):
        """'key' in tree works for top-level keys."""
        tree_with_comm['z'] = 1
        assert 'z' in tree_with_comm
        assert 'missing' not in tree_with_comm

    def test_contains_nested(self, tree_with_comm):
        """'a.b' in tree works for nested keys."""
        tree_with_comm['a.b'] = 2
        assert 'a.b' in tree_with_comm
        assert 'a.c' not in tree_with_comm

    def test_delete_simple(self, tree_with_comm):
        """Deleting a top-level key works."""
        tree_with_comm['q'] = 5
        del tree_with_comm['q']
        assert 'q' not in tree_with_comm

    def test_delete_nested(self, tree_with_comm):
        """Deleting a nested path removes the leaf."""
        tree_with_comm['a.b.c'] = 3
        del tree_with_comm['a.b.c']
        # Parent nodes still exist, but leaf is gone
        assert 'a.b.c' not in tree_with_comm
        assert 'a' in tree_with_comm

    def test_get_missing_raises_pdv_key_error(self, tree_with_comm):
        """Getting a non-existent key raises PDVKeyError."""
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm['nonexistent']

    def test_invalid_path_raises_pdv_path_error(self, tree_with_comm):
        """A path with an empty segment raises PDVPathError."""
        with pytest.raises(PDVPathError):
            _ = tree_with_comm['a..b']


class TestLazyLoading:
    """Tests for the LazyLoadRegistry and transparent lazy fetching."""

    def test_registry_register_and_has(self):
        """Registering a path sets has() to True."""
        reg = LazyLoadRegistry()
        reg.register('x', {'backend': 'inline', 'format': 'inline', 'value': 1})
        assert reg.has('x')
        assert not reg.has('y')

    def test_registry_fetch_removes_entry(self, tmp_save_dir):
        """Fetching a path removes it from the registry."""
        reg = LazyLoadRegistry()
        reg.register('x', {'backend': 'inline', 'format': 'inline', 'value': 42})
        result = reg.fetch('x', tmp_save_dir)
        assert result == 42
        assert not reg.has('x')

    def test_tree_get_triggers_lazy_load(self, tree_with_comm, tmp_save_dir):
        """Getting a key absent from memory but in registry triggers lazy load."""
        numpy = pytest.importorskip('numpy')
        arr = numpy.array([1.0, 2.0, 3.0])
        tree_dir = os.path.join(tmp_save_dir, 'tree')
        os.makedirs(tree_dir, exist_ok=True)
        numpy.save(os.path.join(tree_dir, 'x.npy'), arr)

        tree_with_comm._lazy_registry.register('x', {
            'backend': 'local_file',
            'relative_path': 'tree/x.npy',
            'format': 'npy',
        })
        tree_with_comm._set_save_dir(tmp_save_dir)
        result = tree_with_comm['x']
        assert numpy.array_equal(result, arr)

    def test_lazy_load_caches_result(self, tree_with_comm, tmp_save_dir):
        """After lazy load, second access returns cached value (no second disk read)."""
        numpy = pytest.importorskip('numpy')
        arr = numpy.array([7.0])
        tree_dir = os.path.join(tmp_save_dir, 'tree')
        os.makedirs(tree_dir, exist_ok=True)
        numpy.save(os.path.join(tree_dir, 'y.npy'), arr)

        tree_with_comm._lazy_registry.register('y', {
            'backend': 'local_file',
            'relative_path': 'tree/y.npy',
            'format': 'npy',
        })
        tree_with_comm._set_save_dir(tmp_save_dir)
        r1 = tree_with_comm['y']
        # After first access, entry is removed from registry
        assert not tree_with_comm._lazy_registry.has('y')
        r2 = tree_with_comm['y']  # served from in-memory cache now
        assert numpy.array_equal(r1, r2)

    def test_registry_clear_clears_all(self):
        """clear() removes all entries."""
        reg = LazyLoadRegistry()
        reg.register('a', {'backend': 'inline', 'format': 'inline', 'value': 1})
        reg.register('b', {'backend': 'inline', 'format': 'inline', 'value': 2})
        reg.clear()
        assert not reg.has('a')
        assert not reg.has('b')

    def test_registry_entries_get_and_remove(self):
        """Registry helper accessors expose and remove lazy entries."""
        reg = LazyLoadRegistry()
        reg.register('x', {'backend': 'inline', 'format': 'inline', 'value': 1})
        assert reg.get_storage('x') == {'backend': 'inline', 'format': 'inline', 'value': 1}
        assert ('x', {'backend': 'inline', 'format': 'inline', 'value': 1}) in reg.entries()
        reg.remove('x')
        assert reg.get_storage('x') is None

    def test_tree_lazy_accessors(self, tree_with_comm):
        """PDVTree exposes lazy lookup helpers for handler use."""
        tree_with_comm._lazy_registry.register('a.b', {'backend': 'inline', 'format': 'inline', 'value': 1})
        assert tree_with_comm.has_lazy_entry('a.b')
        assert tree_with_comm.lazy_storage_for('a.b') == {'backend': 'inline', 'format': 'inline', 'value': 1}
        assert ('a.b', {'backend': 'inline', 'format': 'inline', 'value': 1}) in tree_with_comm.iter_lazy_entries()

    def test_populate_from_index_registers_lazy_nodes(self, tmp_save_dir):
        """populate_from_index() registers exactly the nodes marked lazy=True."""
        reg = LazyLoadRegistry()
        nodes = [
            {'path': 'x', 'lazy': True, 'storage': {
                'backend': 'local_file', 'relative_path': 'tree/x.npy', 'format': 'npy'
            }},
            {'path': 'y', 'lazy': False, 'storage': {
                'backend': 'inline', 'format': 'inline', 'value': 1
            }},
            {'path': 'z', 'type': 'folder', 'lazy': False, 'storage': {
                'backend': 'none', 'format': 'none'
            }},
        ]
        reg.populate_from_index(nodes)
        assert reg.has('x')
        assert not reg.has('y')
        assert not reg.has('z')


class TestChangeNotification:
    """Tests for pdv.tree.changed push notifications."""

    def test_set_emits_notification(self, tree_with_comm, mock_send):
        """Setting a value emits pdv.tree.changed."""
        tree_with_comm['a'] = 1
        mock_send.assert_called()
        msg_type, _ = mock_send.call_args[0]
        assert msg_type == 'pdv.tree.changed'

    def test_delete_emits_notification(self, tree_with_comm, mock_send):
        """Deleting a value emits pdv.tree.changed."""
        tree_with_comm['a'] = 1
        mock_send.reset_mock()
        del tree_with_comm['a']
        mock_send.assert_called()
        msg_type, _ = mock_send.call_args[0]
        assert msg_type == 'pdv.tree.changed'

    def test_no_notification_without_comm(self):
        """Without comm attached, set does not raise."""
        tree = PDVTree()
        tree['x'] = 1  # should not raise even without comm

    def test_notification_payload_contains_path(self, tree_with_comm, mock_send):
        """pdv.tree.changed payload includes the changed path."""
        tree_with_comm['my_key'] = 42
        _, payload = mock_send.call_args[0]
        assert 'my_key' in payload.get('changed_paths', [])


class TestPDVScript:
    """Tests for PDVScript."""

    def test_run_calls_script_run_function(self, tree_with_comm, tmp_working_dir, tmp_path):
        """PDVScript.run() calls the script's run() function."""
        script_file = tmp_path / 'test_script.py'
        script_file.write_text('def run(tree, **kwargs):\n    return 42\n')
        script = PDVScript(relative_path=str(script_file), language='python')
        result = script.run(tree_with_comm)
        assert result == 42

    def test_run_passes_tree_as_first_arg(self, tree_with_comm, tmp_path):
        """The tree is passed as the first argument to the script run()."""
        script_file = tmp_path / 'check_tree.py'
        script_file.write_text('def run(tree, **kwargs):\n    return type(tree).__name__\n')
        script = PDVScript(relative_path=str(script_file))
        result = script.run(tree_with_comm)
        assert result == 'PDVTree'

    def test_run_uses_global_tree_when_tree_argument_is_omitted(self, tree_with_comm, tmp_path, monkeypatch):
        """Calling script.run(**kwargs) uses the bootstrapped global tree."""
        from pdv_kernel import comms

        script_file = tmp_path / 'global_tree.py'
        script_file.write_text('def run(tree, **kwargs):\n    return tree["x"]\n')
        script = PDVScript(relative_path=str(script_file))
        tree_with_comm['x'] = 7
        monkeypatch.setattr(comms, '_pdv_tree', tree_with_comm)
        assert script.run() == 7

    def test_run_missing_file_raises(self, tree_with_comm):
        """Running a non-existent script raises FileNotFoundError."""
        script = PDVScript(relative_path='/nonexistent/path/to/script.py')
        with pytest.raises(FileNotFoundError):
            script.run(tree_with_comm)

    def test_run_no_run_fn_raises(self, tree_with_comm, tmp_path):
        """Running a script without run() raises PDVScriptError."""
        script_file = tmp_path / 'no_run.py'
        script_file.write_text('x = 1\n')
        script = PDVScript(relative_path=str(script_file))
        with pytest.raises(PDVScriptError):
            script.run(tree_with_comm)

    def test_preview(self, tmp_path):
        """preview() returns the first line of the script docstring."""
        script = PDVScript(relative_path='scripts/test.py', doc='My script does stuff\nmore details')
        assert script.preview() == 'My script does stuff'

    def test_run_script_via_tree(self, tree_with_comm, tmp_path):
        """pdv_tree.run_script('path') works end-to-end."""
        script_file = tmp_path / 'myrun.py'
        script_file.write_text('def run(tree, **kwargs):\n    return 100\n')
        tree_with_comm['s'] = PDVScript(relative_path=str(script_file))
        result = tree_with_comm.run_script('s')
        assert result == 100

    def test_params_extracted_from_run_signature(self, tmp_path):
        """PDVScript extracts user-facing params from run() signature."""
        script_file = tmp_path / 'param_script.py'
        script_file.write_text(
            'def run(pdv_tree: dict, required_count: int, scale: float = 1.5, label=None):\n'
            '    return {}\n'
        )
        script = PDVScript(relative_path=str(script_file))
        assert script.params == [
            {'name': 'required_count', 'type': 'int', 'default': None, 'required': True},
            {'name': 'scale', 'type': 'float', 'default': 1.5, 'required': False},
            {'name': 'label', 'type': 'any', 'default': None, 'required': False},
        ]

    def test_params_empty_when_script_is_missing_or_invalid(self, tmp_path):
        """Missing or invalid script files produce an empty params list."""
        missing = PDVScript(relative_path=str(tmp_path / 'does_not_exist.py'))
        assert missing.params == []

        invalid_file = tmp_path / 'invalid.py'
        invalid_file.write_text('def run(pdv_tree,\n')
        invalid = PDVScript(relative_path=str(invalid_file))
        assert invalid.params == []
