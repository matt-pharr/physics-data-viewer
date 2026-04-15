"""
pdv-python/tests/test_namespace.py — Unit tests for pdv_kernel.namespace.

Tests cover:
1. PDVNamespace blocks reassignment/deletion of pdv_tree and pdv.
2. PDVNamespace allows normal assignment/deletion of other names.
3. pdv_namespace() snapshot filtering (private, modules, callables).

Reference: ARCHITECTURE.md §5.4, §5.5
"""

from dataclasses import dataclass
from pathlib import Path

import pytest
from pdv_kernel import comms
from pdv_kernel.namespace import PDVApp, PDVNamespace, pdv_namespace
from pdv_kernel.errors import PDVError, PDVProtectedNameError
from pdv_kernel.tree import PDVTree


class TestPDVNamespace:
    def test_set_protected_name_raises(self):
        """Assigning pdv_tree raises PDVProtectedNameError."""
        ns = PDVNamespace()
        with pytest.raises(PDVProtectedNameError):
            ns["pdv_tree"] = "anything"

    def test_set_pdv_raises(self):
        """Assigning pdv raises PDVProtectedNameError."""
        ns = PDVNamespace()
        with pytest.raises(PDVProtectedNameError):
            ns["pdv"] = "anything"

    def test_set_normal_name_allowed(self):
        """Normal variable assignment works."""
        ns = PDVNamespace()
        ns["my_var"] = 42
        assert ns["my_var"] == 42

    def test_delete_protected_name_raises(self):
        """Deleting pdv_tree raises PDVProtectedNameError."""
        ns = PDVNamespace()
        dict.__setitem__(ns, "pdv_tree", object())  # inject directly
        with pytest.raises(PDVProtectedNameError):
            del ns["pdv_tree"]

    def test_delete_normal_name_allowed(self):
        """Deleting a normal variable works."""
        ns = PDVNamespace()
        ns["my_var"] = 99
        del ns["my_var"]
        assert "my_var" not in ns

    def test_initial_inject_bypass(self):
        """Injecting pdv_tree via dict.__setitem__ (bootstrap path) does not raise."""
        ns = PDVNamespace()
        # Bootstrap uses dict.__setitem__ to bypass the guard
        dict.__setitem__(ns, "pdv_tree", object())
        assert "pdv_tree" in ns


class TestPDVAppWorkingDir:
    def test_working_dir_returns_tree_working_dir(self, tmp_path, monkeypatch):
        tree = PDVTree()
        tree._set_working_dir(str(tmp_path))
        monkeypatch.setattr(comms, "_pdv_tree", tree)
        assert PDVApp().working_dir == Path(str(tmp_path))

    def test_working_dir_raises_before_init(self, monkeypatch):
        monkeypatch.setattr(comms, "_pdv_tree", None)
        with pytest.raises(PDVError):
            _ = PDVApp().working_dir

    def test_working_dir_raises_when_unset(self, monkeypatch):
        tree = PDVTree()
        monkeypatch.setattr(comms, "_pdv_tree", tree)
        with pytest.raises(PDVError):
            _ = PDVApp().working_dir


class TestPDVNamespaceSnapshot:
    def test_excludes_pdv_tree(self, fresh_namespace):
        """pdv_namespace() result does not contain pdv_tree."""
        result = pdv_namespace(fresh_namespace)
        assert "pdv_tree" not in result

    def test_excludes_pdv(self, fresh_namespace):
        """pdv_namespace() result does not contain pdv."""
        result = pdv_namespace(fresh_namespace)
        assert "pdv" not in result

    def test_excludes_private_by_default(self, fresh_namespace):
        """Private names are excluded unless include_private=True."""
        dict.__setitem__(fresh_namespace, "_private", 42)
        result = pdv_namespace(fresh_namespace)
        assert "_private" not in result

    def test_includes_private_when_requested(self, fresh_namespace):
        """Private names are included when include_private=True."""
        dict.__setitem__(fresh_namespace, "_private", 42)
        result = pdv_namespace(fresh_namespace, include_private=True)
        assert "_private" in result

    def test_descriptor_has_type_and_preview(self, fresh_namespace):
        """Each descriptor in the result has type and preview fields."""
        # Add a normal variable
        dict.__setitem__(fresh_namespace, "my_int", 7)
        result = pdv_namespace(fresh_namespace)
        assert "my_int" in result
        desc = result["my_int"]
        assert "type" in desc
        assert "preview" in desc

    def test_excludes_pdv_internal_names(self, fresh_namespace):
        """Names starting with _pdv are always excluded."""
        dict.__setitem__(fresh_namespace, "_pdv_internal", "secret")
        result = pdv_namespace(fresh_namespace, include_private=True)
        assert "_pdv_internal" not in result

    def test_normal_variable_included(self, fresh_namespace):
        """Regular user variables appear in the result."""
        dict.__setitem__(fresh_namespace, "result_data", [1, 2, 3])
        result = pdv_namespace(fresh_namespace)
        assert "result_data" in result

    def test_ndarray_descriptor_has_children_and_preview(self, fresh_namespace):
        """ndarrays expose lazy-inspection metadata and sampled previews."""
        numpy = pytest.importorskip("numpy")
        dict.__setitem__(fresh_namespace, "arr", numpy.array([1, 2, 3]))
        result = pdv_namespace(fresh_namespace)
        desc = result["arr"]
        assert desc["kind"] == "ndarray"
        assert desc["has_children"] is True
        assert desc["child_count"] == 3
        assert "array" in desc["preview"]

    def test_custom_object_uses_object_kind_and_attribute_count(self, fresh_namespace):
        """Custom objects with attributes inspect as object nodes."""

        @dataclass
        class Sample:
            alpha: int
            beta: int

        dict.__setitem__(fresh_namespace, "sample", Sample(alpha=1, beta=2))
        result = pdv_namespace(fresh_namespace)
        desc = result["sample"]
        assert desc["kind"] == "object"
        assert desc["has_children"] is True
        assert desc["child_count"] == 2
