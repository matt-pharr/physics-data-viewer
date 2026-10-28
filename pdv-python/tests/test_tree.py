"""
pdv-python/tests/test_tree.py — Unit tests for PDVTree and PDVScript.

Tests are organized around two areas:

1. Dot-path access: set, get, delete, contains via nested paths.
2. Change notification: mutations emit pdv.tree.changed with correct diff.

Reference: ARCHITECTURE.md §5.6, §5.7, §5.8, §7.1
"""


import pytest
from pdv.tree import PDVTree, PDVScript
from pdv.errors import PDVKeyError, PDVPathError, PDVScriptError


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

    def test_get_indexes_into_list(self, tree_with_comm):
        """A numeric segment indexes into a list value."""
        tree_with_comm["xs"] = [10, 20, 30]
        assert tree_with_comm["xs.0"] == 10
        assert tree_with_comm["xs.2"] == 30

    def test_get_indexes_into_tuple(self, tree_with_comm):
        """A numeric segment indexes into a tuple value."""
        tree_with_comm["pair"] = ("a", "b")
        assert tree_with_comm["pair.1"] == "b"

    def test_get_descends_through_list_into_dict(self, tree_with_comm):
        """Dot-path descends through list indices into nested dicts."""
        tree_with_comm["records"] = [{"name": "a"}, {"name": "b"}]
        assert tree_with_comm["records.0.name"] == "a"
        assert tree_with_comm["records.1.name"] == "b"

    def test_negative_index_returns_from_end(self, tree_with_comm):
        """Negative indices in a dot-path index from the end of the list,
        following Python's native sequence-indexing semantics."""
        tree_with_comm["xs"] = [10, 20, 30]
        assert tree_with_comm["xs.-1"] == 30
        assert tree_with_comm["xs.-2"] == 20

    def test_index_out_of_range_raises_key_error(self, tree_with_comm):
        """Out-of-range index on a list raises PDVKeyError."""
        tree_with_comm["xs"] = [1, 2]
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm["xs.5"]
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm["xs.-5"]

    def test_non_numeric_segment_into_list_raises_key_error(self, tree_with_comm):
        """Non-numeric segment into a list value raises PDVKeyError."""
        tree_with_comm["xs"] = [1, 2, 3]
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm["xs.foo"]

    def test_contains_indexed_path(self, tree_with_comm):
        """`'xs.0' in tree` works for list values."""
        tree_with_comm["xs"] = [1, 2]
        assert "xs.0" in tree_with_comm
        assert "xs.5" not in tree_with_comm
        assert "xs.foo" not in tree_with_comm

    def test_get_descends_into_xarray_dataset(self, tree_with_comm):
        """A dot-path segment after a Dataset resolves via Dataset[name]."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        ds = xr.Dataset(
            {"a": (("t",), np.array([1.0, 2.0, 3.0]))},
            coords={"t": [10, 20, 30]},
        )
        tree_with_comm["ds"] = ds
        result = tree_with_comm["ds.a"]
        assert isinstance(result, xr.DataArray)
        assert result.equals(ds["a"])

    def test_get_descends_to_dataset_coord(self, tree_with_comm):
        """Coord names resolve via the Dataset virtual-children adapter,
        matching the tree panel, which lists data_vars and coords."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        ds = xr.Dataset(
            {"a": (("t",), np.array([1.0, 2.0]))},
            coords={"t": [10, 20]},
        )
        tree_with_comm["ds"] = ds
        result = tree_with_comm["ds.t"]
        assert isinstance(result, xr.DataArray)
        assert list(result.values) == [10, 20]

    def test_dataset_missing_key_raises_pdv_key_error(self, tree_with_comm):
        """Unknown var/coord names raise PDVKeyError."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        tree_with_comm["ds"] = xr.Dataset(
            {"a": (("t",), np.array([1.0]))}
        )
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm["ds.missing"]

    def test_no_descent_through_dataarray(self, tree_with_comm):
        """DataArrays are leaves — descending past one with another
        segment raises PDVKeyError (we do not interpret da[label] as
        dimension indexing)."""
        xr = pytest.importorskip("xarray")
        import numpy as np
        tree_with_comm["ds"] = xr.Dataset(
            {"a": (("t",), np.array([1.0, 2.0]))}
        )
        with pytest.raises(PDVKeyError):
            _ = tree_with_comm["ds.a.0"]


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

    def test_set_emits_for_newly_created_intermediates(
        self, tree_with_comm, mock_send
    ):
        """Setting a deep path on an empty tree emits for each new ancestor.

        Renderers use changed_paths to decide which subtree to re-fetch.
        Without per-intermediate events, the parent of a deep leaf may not
        yet exist in the renderer's view, so nothing refreshes. See the
        Tree component in the Electron renderer.
        """
        tree_with_comm["imports.mesh"] = 1
        tree_with_comm._flush_changes()
        _, payload = mock_send.call_args[0]
        assert set(payload["changed_paths"]) == {"imports", "imports.mesh"}

    def test_set_does_not_emit_for_existing_intermediates(
        self, tree_with_comm, mock_send
    ):
        """If all intermediates already exist as dicts, no extra events fire."""
        tree_with_comm["imports.other"] = 1
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm["imports.mesh"] = 2
        tree_with_comm._flush_changes()
        _, payload = mock_send.call_args[0]
        assert payload["changed_paths"] == ["imports.mesh"]

    def test_set_emits_for_all_newly_created_deep_ancestors(
        self, tree_with_comm, mock_send
    ):
        """A three-level new path emits for each intermediate ancestor."""
        tree_with_comm["a.b.c"] = 1
        tree_with_comm._flush_changes()
        _, payload = mock_send.call_args[0]
        assert set(payload["changed_paths"]) == {"a", "a.b", "a.b.c"}

    def test_set_replacing_non_dict_intermediate_emits_for_that_ancestor(
        self, tree_with_comm, mock_send
    ):
        """When set_quiet replaces a non-dict intermediate with a PDVTree,
        that ancestor counts as newly created for renderer purposes."""
        tree_with_comm["imports"] = 5  # leaf, not a dict
        tree_with_comm._flush_changes()
        mock_send.reset_mock()
        tree_with_comm["imports.mesh"] = "v"
        tree_with_comm._flush_changes()
        _, payload = mock_send.call_args[0]
        assert set(payload["changed_paths"]) == {"imports", "imports.mesh"}


class TestGlobalPing:
    """Tests for the class-level "global ping" emitted by non-root PDVTrees.

    Mutations on detached or sub-tree PDVTree instances cannot emit precise
    paths (their local path has no relationship to the root tree), so they
    fire a coarse ``change_type: "unknown"`` notification that the renderer
    treats as "refetch the visible tree."
    """

    def test_subtree_mutation_emits_unknown(self, tree_with_comm, mock_send):
        """Mutating an intermediate PDVTree fires a global unknown ping."""
        tree_with_comm["a.b"] = 0
        tree_with_comm._flush_changes()
        mock_send.reset_mock()

        # Mutate the sub-tree directly, bypassing the root.
        sub = tree_with_comm["a"]
        assert isinstance(sub, PDVTree)
        sub["c"] = 99
        PDVTree._flush_global()

        mock_send.assert_called_once()
        msg_type, payload = mock_send.call_args[0]
        assert msg_type == "pdv.tree.changed"
        assert payload["change_type"] == "unknown"
        assert payload["changed_paths"] == []

    def test_detached_tree_mutation_emits_unknown(self, tree_with_comm, mock_send):
        """A scratch PDVTree the user constructs locally also pings."""
        tree_with_comm._flush_changes()
        mock_send.reset_mock()

        scratch = PDVTree()
        scratch["x"] = 1
        PDVTree._flush_global()

        mock_send.assert_called_once()
        _, payload = mock_send.call_args[0]
        assert payload["change_type"] == "unknown"

    def test_root_mutation_does_not_fire_global(self, tree_with_comm, mock_send):
        """Root-tree mutations use precise paths, not the global ping."""
        tree_with_comm["x"] = 1
        tree_with_comm._flush_changes()
        # Global timer should not have been scheduled.
        PDVTree._flush_global()
        # Only the precise-path emit should have fired.
        msg_types = [call[0][0] for call in mock_send.call_args_list]
        assert msg_types.count("pdv.tree.changed") == 1
        _, payload = mock_send.call_args[0]
        assert payload["change_type"] == "batch"

    def test_detach_clears_global_state(self, tmp_working_dir, mock_send):
        """Detaching the root tree silences future global pings."""
        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        tree._attach_comm(mock_send)
        tree._detach_comm()

        scratch = PDVTree()
        scratch["x"] = 1
        PDVTree._flush_global()
        mock_send.assert_not_called()


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
        node_uuid = "abc123def456"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "test_script.py"
        script_file.write_text("def run(tree, **kwargs):\n    return 42\n")
        tree_with_comm._set_working_dir(str(tmp_path))
        script = PDVScript(uuid=node_uuid, filename="test_script.py", language="python")
        result = script.run(tree_with_comm)
        assert result == 42

    def test_run_passes_tree_as_first_arg(self, tree_with_comm, tmp_path):
        """The tree is passed as the first argument to the script run()."""
        node_uuid = "abc123def457"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "check_tree.py"
        script_file.write_text(
            "def run(tree, **kwargs):\n    return type(tree).__name__\n"
        )
        tree_with_comm._set_working_dir(str(tmp_path))
        script = PDVScript(uuid=node_uuid, filename="check_tree.py")
        result = script.run(tree_with_comm)
        assert result == "PDVTree"

    def test_run_uses_global_tree_when_tree_argument_is_omitted(
        self, tree_with_comm, tmp_path, monkeypatch
    ):
        """Calling script.run(**kwargs) uses the bootstrapped global tree."""
        from pdv import comms

        node_uuid = "abc123def458"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "global_tree.py"
        script_file.write_text('def run(tree, **kwargs):\n    return tree["x"]\n')
        tree_with_comm._set_working_dir(str(tmp_path))
        script = PDVScript(uuid=node_uuid, filename="global_tree.py")
        tree_with_comm["x"] = 7
        monkeypatch.setattr(comms, "_pdv_tree", tree_with_comm)
        assert script.run() == 7

    def test_run_missing_file_raises(self, tree_with_comm):
        """Running a non-existent script raises FileNotFoundError."""
        script = PDVScript(uuid="missing_uuid1", filename="script.py")
        with pytest.raises(FileNotFoundError):
            script.run(tree_with_comm)

    def test_run_no_run_fn_raises(self, tree_with_comm, tmp_path):
        """Running a script without run() raises PDVScriptError."""
        node_uuid = "abc123def459"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "no_run.py"
        script_file.write_text("x = 1\n")
        tree_with_comm._set_working_dir(str(tmp_path))
        script = PDVScript(uuid=node_uuid, filename="no_run.py")
        with pytest.raises(PDVScriptError):
            script.run(tree_with_comm)

    def test_preview(self, tmp_path):
        """preview() returns the first line of the script docstring."""
        script = PDVScript(
            uuid="abc123def460", filename="test.py", doc="My script does stuff\nmore details"
        )
        assert script.preview() == "My script does stuff"

    def test_run_script_via_tree(self, tree_with_comm, tmp_path):
        """pdv_tree.run_script('path') works end-to-end."""
        node_uuid = "abc123def461"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "myrun.py"
        script_file.write_text("def run(tree, **kwargs):\n    return 100\n")
        tree_with_comm._set_working_dir(str(tmp_path))
        tree_with_comm["s"] = PDVScript(uuid=node_uuid, filename="myrun.py")
        result = tree_with_comm.run_script("s")
        assert result == 100

    def test_extract_script_params_from_run_signature(self, tmp_path):
        """_extract_script_params extracts user-facing params from run() signature."""
        from pdv.tree import _extract_script_params

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

    def test_extract_script_params_does_not_execute_the_script(self, tmp_path):
        """Param extraction must be side-effect-free: the UI calls it via
        pdv.script.params, and the old import-based implementation ran the
        script's entire top-level code just to read run()'s signature."""
        script_file = tmp_path / "side_effect.py"
        sentinel = tmp_path / "executed.txt"
        script_file.write_text(
            f"open({str(sentinel)!r}, 'w').write('ran')\n"
            "def run(pdv_tree: dict, n: int = 3):\n"
            "    return {}\n"
        )
        from pdv.tree import _extract_script_params

        params = _extract_script_params(str(script_file))
        assert params == [
            {"name": "n", "type": "int", "default": 3, "required": False}
        ]
        assert not sentinel.exists()

    def test_extract_script_params_nonliteral_default_falls_back_to_source(
        self, tmp_path
    ):
        """Non-literal defaults can't be evaluated without importing the
        script, so their source text is surfaced instead."""
        script_file = tmp_path / "nonliteral.py"
        script_file.write_text(
            "import numpy as np\n"
            "def run(pdv_tree: dict, angle: float = np.pi, *, tag: str = 'x'):\n"
            "    return {}\n"
        )
        from pdv.tree import _extract_script_params

        assert _extract_script_params(str(script_file)) == [
            {"name": "angle", "type": "float", "default": "np.pi", "required": False},
            {"name": "tag", "type": "str", "default": "x", "required": False},
        ]

    def test_extract_script_params_empty_when_missing_or_invalid(self, tmp_path):
        """Missing or invalid script files produce an empty params list."""
        from pdv.tree import _extract_script_params

        assert _extract_script_params(str(tmp_path / "does_not_exist.py")) == []

        invalid_file = tmp_path / "invalid.py"
        invalid_file.write_text("def run(pdv_tree,\n")
        assert _extract_script_params(str(invalid_file)) == []


class TestDebounceHygiene:
    """Regression tests for debounce-timer thread leaks (the sweep flake).

    A leaked ``Timer(0.1, _flush_global)`` fires ~100 ms after its test
    ends, sending a stray ``pdv.tree.changed`` into whatever comm patch a
    *later* test has open. Two layers close it: ``_flush_changes`` cancels
    the in-flight instance timer, and the autouse ``_reset_global_debounce``
    conftest fixture disarms the class-level machinery after every test.
    """

    def test_flush_changes_cancels_pending_timer(self, tree_with_comm, monkeypatch):
        """A manual flush must stop the timer thread, not orphan it."""
        # Long interval so the timer cannot fire on its own mid-test on a
        # loaded machine; cancel() below keeps teardown instant.
        monkeypatch.setattr(PDVTree, "_DEBOUNCE_INTERVAL", 60.0)
        tree_with_comm["x"] = 1
        timer = tree_with_comm._debounce_timer
        assert timer is not None
        tree_with_comm._flush_changes()
        # Timer.cancel() sets the internal finished event; without the
        # cancel, the thread stays live for the full debounce interval.
        assert timer.finished.is_set()
        assert tree_with_comm._debounce_timer is None

    def test_disarm_global_debounce_clears_leaked_state(self, mock_send, monkeypatch):
        """The disarm the autouse conftest fixture relies on works.

        Reproduces the historical leak in-test (attach without detach, then
        a non-root mutation arming the class-level timer) and asserts
        ``_disarm_global_debounce`` — the exact call the fixture makes —
        cancels and clears everything. Long debounce interval so the timer
        cannot fire on its own mid-test.
        """
        monkeypatch.setattr(PDVTree, "_DEBOUNCE_INTERVAL", 60.0)
        tree = PDVTree()
        tree._attach_comm(mock_send)
        scratch = PDVTree()
        scratch["x"] = 1  # arms the class-level global timer
        assert PDVTree._global_send_fn is not None
        timer = PDVTree._global_timer
        assert timer is not None

        PDVTree._disarm_global_debounce()

        assert timer.finished.is_set()  # cancelled, not just dereferenced
        assert PDVTree._global_timer is None
        assert PDVTree._global_pending is False
        assert PDVTree._global_send_fn is None
        assert PDVTree._root_tree is None
