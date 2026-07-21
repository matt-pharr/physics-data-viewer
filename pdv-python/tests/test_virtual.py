"""
pdv-python/tests/test_virtual.py — Tests for the virtual-children protocol.

Tests cover:
1. get_virtual_adapter dispatch: dunder protocol, foreign registry,
   plain values.
2. The built-in xarray.Dataset adapter (data_vars + coords, coord
   overrides, single-child lookup).
3. The built-in h5py.Group adapter (members, nested groups).
4. Dot-path descent through adapters in PDVTree._resolve_nested,
   including error containment in __contains__.
5. register_virtual extension point.

Reference: ARCHITECTURE.md §7.2 (virtual children)
"""

import pytest

from pdv.tree import PDVTree, _resolve_nested
from pdv.virtual import (
    VirtualAdapter,
    get_virtual_adapter,
    register_virtual,
    _REGISTRY,
)


class _DunderNode:
    """Minimal PDV-owned class implementing the dunder protocol."""

    def __init__(self, children):
        self._children = children

    def __pdv_children__(self):
        return [(k, v, None) for k, v in self._children.items()]

    def __pdv_child__(self, key):
        return self._children[key]


class _FailingDunderNode:
    """Dunder node whose enumeration raises (e.g. missing dependency)."""

    def __pdv_children__(self):
        raise RuntimeError("cannot open")

    def __pdv_child__(self, key):
        raise RuntimeError("cannot open")


class TestGetVirtualAdapter:
    def test_plain_values_have_no_adapter(self):
        for value in (1, "s", None, [1, 2], {"a": 1}, object()):
            assert get_virtual_adapter(value) is None

    def test_dunder_class_gets_adapter(self):
        node = _DunderNode({"a": 1, "b": 2})
        adapter = get_virtual_adapter(node)
        assert adapter is not None
        assert adapter.children(node) == [("a", 1, None), ("b", 2, None)]
        assert adapter.child(node, "b") == 2
        assert adapter.has_children(node) is True
        assert adapter.has_children(_DunderNode({})) is False

    def test_dunder_has_children_never_raises(self):
        adapter = get_virtual_adapter(_FailingDunderNode())
        assert adapter.has_children(_FailingDunderNode()) is False

    def test_dunder_explicit_has_children_probe(self):
        class _Probed(_DunderNode):
            def __pdv_has_children__(self):
                return True

        adapter = get_virtual_adapter(_Probed({}))
        assert adapter.has_children(_Probed({})) is True

    def test_register_virtual_extends_registry(self):
        class _Foreign:
            pass

        class _ForeignAdapter(VirtualAdapter):
            def children(self, obj):
                return [("only", 42, None)]

            def child(self, obj, key):
                if key != "only":
                    raise KeyError(key)
                return 42

            def has_children(self, obj):
                return True

        predicate = lambda v: isinstance(v, _Foreign)  # noqa: E731
        register_virtual(predicate, _ForeignAdapter())
        try:
            adapter = get_virtual_adapter(_Foreign())
            assert adapter is not None
            assert adapter.child(_Foreign(), "only") == 42
        finally:
            _REGISTRY[:] = [
                entry for entry in _REGISTRY if entry[0] is not predicate
            ]


class TestXarrayDatasetAdapter:
    def test_children_vars_then_coords(self):
        xr = pytest.importorskip("xarray")
        import numpy as np

        ds = xr.Dataset(
            {"a": (("x",), np.array([1.0, 2.0])), "b": (("x",), np.zeros(2))},
            coords={"x": [0, 1]},
        )
        adapter = get_virtual_adapter(ds)
        entries = adapter.children(ds)
        assert [e[0] for e in entries] == ["a", "b", "x"]
        assert entries[0][2] is None
        assert entries[2][2] == {"is_coord": True}
        assert entries[2][1].identical(ds["x"])

    def test_child_resolves_vars_and_coords(self):
        xr = pytest.importorskip("xarray")
        import numpy as np

        ds = xr.Dataset(
            {"a": (("x",), np.array([1.0, 2.0]))}, coords={"x": [0, 1]}
        )
        adapter = get_virtual_adapter(ds)
        assert adapter.child(ds, "a").identical(ds["a"])
        assert adapter.child(ds, "x").identical(ds["x"])
        with pytest.raises(KeyError):
            adapter.child(ds, "missing")

    def test_has_children_counts_coords(self):
        xr = pytest.importorskip("xarray")

        adapter_cls = get_virtual_adapter(xr.Dataset())
        assert adapter_cls.has_children(xr.Dataset()) is False
        assert (
            adapter_cls.has_children(xr.Dataset(coords={"x": [0, 1]})) is True
        )


class TestH5pyGroupAdapter:
    def test_children_and_nested_descent(self, tmp_path):
        h5py = pytest.importorskip("h5py")
        import numpy as np

        path = tmp_path / "t.h5"
        with h5py.File(path, "w") as f:
            f.create_dataset("top", data=np.arange(3))
            grp = f.create_group("grp")
            grp.create_dataset("inner", data=np.zeros((2, 2)))

        with h5py.File(path, "r") as f:
            adapter = get_virtual_adapter(f)
            assert adapter is not None
            entries = adapter.children(f)
            assert sorted(e[0] for e in entries) == ["grp", "top"]
            group = adapter.child(f, "grp")
            group_adapter = get_virtual_adapter(group)
            assert group_adapter is not None
            inner = group_adapter.child(group, "inner")
            assert inner.shape == (2, 2)
            assert group_adapter.has_children(group) is True
            with pytest.raises(KeyError):
                adapter.child(f, "missing")

    def test_h5py_dataset_is_leaf(self, tmp_path):
        h5py = pytest.importorskip("h5py")
        import numpy as np

        path = tmp_path / "t.h5"
        with h5py.File(path, "w") as f:
            f.create_dataset("d", data=np.arange(3))
        with h5py.File(path, "r") as f:
            assert get_virtual_adapter(f["d"]) is None


class TestResolveNestedThroughAdapters:
    def test_dunder_descent(self):
        tree = PDVTree()
        tree.set_quiet("a", {"b": _DunderNode({"leaf": 7})})
        assert tree["a.b.leaf"] == 7
        assert "a.b.leaf" in tree

    def test_arbitrary_depth_descent(self):
        inner = _DunderNode({"deep": 99})
        tree = PDVTree()
        tree.set_quiet("a", _DunderNode({"mid": inner}))
        assert tree["a.mid.deep"] == 99

    def test_missing_virtual_key_raises_keyerror(self):
        tree = PDVTree()
        tree.set_quiet("a", _DunderNode({"x": 1}))
        with pytest.raises(KeyError):
            _resolve_nested(tree, ["a", "nope"])

    def test_contains_swallows_adapter_errors(self):
        tree = PDVTree()
        tree.set_quiet("a", _FailingDunderNode())
        assert ("a.anything" in tree) is False

    def test_dataset_descent_still_works(self):
        xr = pytest.importorskip("xarray")
        import numpy as np

        tree = PDVTree()
        tree.set_quiet(
            "ds",
            xr.Dataset(
                {"a": (("x",), np.array([1.0, 2.0]))}, coords={"x": [0, 1]}
            ),
        )
        assert tree["ds.a"].identical(tree["ds"]["a"])
        assert tree["ds.x"].identical(tree["ds"]["x"])
