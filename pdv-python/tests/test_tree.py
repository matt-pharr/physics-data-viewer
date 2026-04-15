"""
pdv-python/tests/test_tree.py — Unit tests for PDVTree and PDVScript.

Tests are organized around two areas:

1. Dot-path access: set, get, delete, contains via nested paths.
2. Change notification: mutations emit pdv.tree.changed with correct diff.

Reference: ARCHITECTURE.md §5.6, §5.7, §5.8, §7.1
"""

import os

import pytest
from pdv_kernel.tree import PDVTree, PDVScript
from pdv_kernel.errors import PDVKeyError, PDVPathError, PDVScriptError


class TestDotPathAccess:
    """Tests for dot-path set/get/delete/contains."""

    def test_simple_set_and_get(self, tree_with_comm):
        """Setting and getting a simple key works."""
        tree_with_comm["x"] = 42
        assert tree_with_comm["x"] == 42

    def test_nested_set_creates_intermediate_nodes(self, tree_with_comm):
        """Setting 'a.b.c' = 1 creates intermediate PDVTree nodes."""
        tree_with_comm["a.b.c"] = 1
        assert isinstance(tree_with_comm["a"], PDVTree)
        assert isinstance(tree_with_comm["a"]["b"], PDVTree)

    def test_nested_get(self, tree_with_comm):
        """Getting a nested path after set returns the correct value."""
        tree_with_comm["a.b.c"] = 99
        assert tree_with_comm["a.b.c"] == 99

    def test_contains_simple(self, tree_with_comm):
        """'key' in tree works for top-level keys."""
        tree_with_comm["z"] = 1
        assert "z" in tree_with_comm
        assert "missing" not in tree_with_comm

    def test_contains_nested(self, tree_with_comm):
        """'a.b' in tree works for nested keys."""
        tree_with_comm["a.b"] = 2
        assert "a.b" in tree_with_comm
        assert "a.c" not in tree_with_comm

    def test_delete_simple(self, tree_with_comm):
        """Deleting a top-level key works."""
        tree_with_comm["q"] = 5
        del tree_with_comm["q"]
        assert "q" not in tree_with_comm

    def test_delete_nested(self, tree_with_comm):
        """Deleting a nested path removes the leaf."""
        tree_with_comm["a.b.c"] = 3
        del tree_with_comm["a.b.c"]
        # Parent nodes still exist, but leaf is gone
        assert "a.b.c" not in tree_with_comm
        assert "a" in tree_with_comm

    def test_get_missing_raises_pdv_key_error(self, tree_with_comm):
        """Getting a non-existent key raises PDVKeyError."""
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm["nonexistent"]

    def test_invalid_path_raises_pdv_path_error(self, tree_with_comm):
        """A path with an empty segment raises PDVPathError."""
        with pytest.raises(PDVPathError):
            _ = tree_with_comm["a..b"]


class TestChangeNotification:
    """Tests for pdv.tree.changed push notifications (debounced)."""

    def test_set_emits_notification(self, tree_with_comm, mock_send):
        """Setting a value emits pdv.tree.changed after flush."""
        tree_with_comm["a"] = 1
        tree_with_comm._flush_changes()
        mock_send.assert_called()
        msg_type, _ = mock_send.call_args[0]
        assert msg_type == "pdv.tree.changed"

    def test_delete_emits_notification(self, tree_with_comm, mock_send):
        """Deleting a value emits pdv.tree.changed after flush."""
        tree_with_comm["a"] = 1
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        del tree_with_comm["a"]
        tree_with_comm._flush_changes()
        mock_send.assert_called()
        msg_type, _ = mock_send.call_args[0]
        assert msg_type == "pdv.tree.changed"

    def test_no_notification_without_comm(self):
        """Without comm attached, set does not raise."""
        tree = PDVTree()
        tree["x"] = 1  # should not raise even without comm

    def test_notification_payload_contains_path(self, tree_with_comm, mock_send):
        """pdv.tree.changed payload includes the changed path."""
        tree_with_comm["my_key"] = 42
        tree_with_comm._flush_changes()
        _, payload = mock_send.call_args[0]
        assert "my_key" in payload.get("changed_paths", [])

    def test_debounce_batches_multiple_mutations(self, tree_with_comm, mock_send):
        """Multiple rapid mutations produce one batched notification."""
        tree_with_comm["a"] = 1
        tree_with_comm["b"] = 2
        tree_with_comm["c"] = 3
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()
        _, payload = mock_send.call_args[0]
        assert payload["change_type"] == "batch"
        assert set(payload["changed_paths"]) == {"a", "b", "c"}

    def test_debounce_deduplicates_paths(self, tree_with_comm, mock_send):
        """Same path mutated multiple times appears once in batch."""
        tree_with_comm["x"] = 1
        tree_with_comm["x"] = 2
        tree_with_comm["x"] = 3
        tree_with_comm._flush_changes()
        _, payload = mock_send.call_args[0]
        assert payload["changed_paths"] == ["x"]


class TestMutatingDictMethods:
    """Tests for dict methods that must emit change notifications."""

    def test_pop_emits_notification(self, tree_with_comm, mock_send):
        tree_with_comm["x"] = 1
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        val = tree_with_comm.pop("x")
        assert val == 1
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()
        _, payload = mock_send.call_args[0]
        assert "x" in payload["changed_paths"]

    def test_pop_nested_path(self, tree_with_comm, mock_send):
        tree_with_comm["a.b"] = 42
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        val = tree_with_comm.pop("a.b")
        assert val == 42
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()

    def test_pop_missing_with_default(self, tree_with_comm, mock_send):
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        result = tree_with_comm.pop("missing", "fallback")
        assert result == "fallback"
        tree_with_comm._flush_changes()
        mock_send.assert_not_called()

    def test_pop_missing_raises(self, tree_with_comm):
        with pytest.raises(PDVKeyError):
            tree_with_comm.pop("missing")

    def test_update_emits_notification(self, tree_with_comm, mock_send):
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm.update({"a": 1, "b": 2})
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()  # batched into one
        _, payload = mock_send.call_args[0]
        assert set(payload["changed_paths"]) == {"a", "b"}

    def test_update_with_kwargs(self, tree_with_comm, mock_send):
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm.update(c=3)
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()
        assert tree_with_comm["c"] == 3

    def test_clear_emits_notification(self, tree_with_comm, mock_send):
        tree_with_comm["a"] = 1
        tree_with_comm["b"] = 2
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm.clear()
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()  # batched into one
        _, payload = mock_send.call_args[0]
        assert set(payload["changed_paths"]) == {"a", "b"}
        assert len(tree_with_comm) == 0

    def test_setdefault_existing_no_notification(self, tree_with_comm, mock_send):
        tree_with_comm["x"] = 10
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        result = tree_with_comm.setdefault("x", 99)
        assert result == 10
        tree_with_comm._flush_changes()
        mock_send.assert_not_called()

    def test_setdefault_missing_emits_notification(self, tree_with_comm, mock_send):
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        result = tree_with_comm.setdefault("new_key", 42)
        assert result == 42
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()

    def test_update_with_iterable_of_pairs(self, tree_with_comm, mock_send):
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm.update([("x", 10), ("y", 20)])
        assert tree_with_comm["x"] == 10
        assert tree_with_comm["y"] == 20
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()

    def test_update_rejects_extra_positional_args(self, tree_with_comm):
        with pytest.raises(TypeError):
            tree_with_comm.update({"a": 1}, {"b": 2})

    def test_ior_emits_notification(self, tree_with_comm, mock_send):
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm |= {"p": 1, "q": 2}
        assert tree_with_comm["p"] == 1
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()

    def test_popitem_emits_notification(self, tree_with_comm, mock_send):
        tree_with_comm["only"] = 1
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        key, val = tree_with_comm.popitem()
        assert key == "only" and val == 1
        tree_with_comm._flush_changes()
        mock_send.assert_called_once()


class TestPDVScript:
    """Tests for PDVScript."""

    def test_run_calls_script_run_function(
        self, tree_with_comm, tmp_working_dir, tmp_path
    ):
        """PDVScript.run() calls the script's run() function."""
        script_file = tmp_path / "test_script.py"
        script_file.write_text("def run(tree, **kwargs):\n    return 42\n")
        script = PDVScript(relative_path=str(script_file), language="python")
        result = script.run(tree_with_comm)
        assert result == 42

    def test_run_passes_tree_as_first_arg(self, tree_with_comm, tmp_path):
        """The tree is passed as the first argument to the script run()."""
        script_file = tmp_path / "check_tree.py"
        script_file.write_text(
            "def run(tree, **kwargs):\n    return type(tree).__name__\n"
        )
        script = PDVScript(relative_path=str(script_file))
        result = script.run(tree_with_comm)
        assert result == "PDVTree"

    def test_run_uses_global_tree_when_tree_argument_is_omitted(
        self, tree_with_comm, tmp_path, monkeypatch
    ):
        """Calling script.run(**kwargs) uses the bootstrapped global tree."""
        from pdv_kernel import comms

        script_file = tmp_path / "global_tree.py"
        script_file.write_text('def run(tree, **kwargs):\n    return tree["x"]\n')
        script = PDVScript(relative_path=str(script_file))
        tree_with_comm["x"] = 7
        monkeypatch.setattr(comms, "_pdv_tree", tree_with_comm)
        assert script.run() == 7

    def test_run_missing_file_raises(self, tree_with_comm):
        """Running a non-existent script raises FileNotFoundError."""
        script = PDVScript(relative_path="/nonexistent/path/to/script.py")
        with pytest.raises(FileNotFoundError):
            script.run(tree_with_comm)

    def test_run_no_run_fn_raises(self, tree_with_comm, tmp_path):
        """Running a script without run() raises PDVScriptError."""
        script_file = tmp_path / "no_run.py"
        script_file.write_text("x = 1\n")
        script = PDVScript(relative_path=str(script_file))
        with pytest.raises(PDVScriptError):
            script.run(tree_with_comm)

    def test_preview(self, tmp_path):
        """preview() returns the first line of the script docstring."""
        script = PDVScript(
            relative_path="scripts/test.py", doc="My script does stuff\nmore details"
        )
        assert script.preview() == "My script does stuff"

    def test_run_script_via_tree(self, tree_with_comm, tmp_path):
        """pdv_tree.run_script('path') works end-to-end."""
        script_file = tmp_path / "myrun.py"
        script_file.write_text("def run(tree, **kwargs):\n    return 100\n")
        tree_with_comm["s"] = PDVScript(relative_path=str(script_file))
        result = tree_with_comm.run_script("s")
        assert result == 100

    def test_extract_script_params_from_run_signature(self, tmp_path):
        """_extract_script_params extracts user-facing params from run() signature."""
        from pdv_kernel.tree import _extract_script_params

        script_file = tmp_path / "param_script.py"
        script_file.write_text(
            "def run(pdv_tree: dict, required_count: int, scale: float = 1.5, label=None):\n"
            "    return {}\n"
        )
        assert _extract_script_params(str(script_file)) == [
            {
                "name": "required_count",
                "type": "int",
                "default": None,
                "required": True,
            },
            {"name": "scale", "type": "float", "default": 1.5, "required": False},
            {"name": "label", "type": "any", "default": None, "required": False},
        ]

    def test_extract_script_params_empty_when_missing_or_invalid(self, tmp_path):
        """Missing or invalid script files produce an empty params list."""
        from pdv_kernel.tree import _extract_script_params

        assert _extract_script_params(str(tmp_path / "does_not_exist.py")) == []

        invalid_file = tmp_path / "invalid.py"
        invalid_file.write_text("def run(pdv_tree,\n")
        assert _extract_script_params(str(invalid_file)) == []
