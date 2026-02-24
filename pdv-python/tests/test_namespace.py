"""
pdv-python/tests/test_namespace.py — Unit tests for pdv_kernel.namespace.

Tests cover:
1. PDVNamespace blocks reassignment/deletion of pdv_tree and pdv.
2. PDVNamespace allows normal assignment/deletion of other names.
3. pdv_namespace() snapshot filtering (private, modules, callables).

Reference: ARCHITECTURE.md §5.4, §5.5
"""

import pytest
from pdv_kernel.namespace import PDVNamespace, pdv_namespace
from pdv_kernel.errors import PDVProtectedNameError


class TestPDVNamespace:
    def test_set_protected_name_raises(self):
        """Assigning pdv_tree raises PDVProtectedNameError."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_set_pdv_raises(self):
        """Assigning pdv raises PDVProtectedNameError."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_set_normal_name_allowed(self):
        """Normal variable assignment works."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_delete_protected_name_raises(self):
        """Deleting pdv_tree raises PDVProtectedNameError."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_delete_normal_name_allowed(self):
        """Deleting a normal variable works."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_initial_inject_bypass(self):
        """Injecting pdv_tree via dict.__setitem__ (bootstrap path) does not raise."""
        # TODO: implement in Step 2
        raise NotImplementedError


class TestPDVNamespaceSnapshot:
    def test_excludes_pdv_tree(self, fresh_namespace):
        """pdv_namespace() result does not contain pdv_tree."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_excludes_pdv(self, fresh_namespace):
        """pdv_namespace() result does not contain pdv."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_excludes_private_by_default(self, fresh_namespace):
        """Private names are excluded unless include_private=True."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_includes_private_when_requested(self, fresh_namespace):
        """Private names are included when include_private=True."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_descriptor_has_type_and_preview(self, fresh_namespace):
        """Each descriptor in the result has type and preview fields."""
        # TODO: implement in Step 2
        raise NotImplementedError
