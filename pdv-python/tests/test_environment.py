"""
pdv-python/tests/test_environment.py — Unit tests for pdv_kernel.environment.

Tests cover:
1. validate_working_dir() happy path and error cases.
2. resolve_project_path() path-traversal rejection.
3. path_is_safe() boundary cases.
4. working_dir_tree_path() path construction.
5. ensure_parent() directory creation.

Reference: ARCHITECTURE.md §6.1, §6.2
"""

import os
import pytest
from pdv_kernel.environment import (
    validate_working_dir,
    resolve_project_path,
    path_is_safe,
    working_dir_tree_path,
    ensure_parent,
)
from pdv_kernel.errors import PDVPathError


class TestValidateWorkingDir:
    def test_valid_dir(self, tmp_working_dir):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_nonexistent_dir_raises(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_not_a_directory_raises(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError


class TestResolveProjectPath:
    def test_simple_relative_path(self, tmp_save_dir):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_nested_relative_path(self, tmp_save_dir):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_traversal_rejected(self, tmp_save_dir):
        """A path with '../' must raise PDVPathError."""
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_absolute_path_rejected(self, tmp_save_dir):
        """An absolute path must raise PDVPathError."""
        # TODO: implement in Step 1
        raise NotImplementedError


class TestPathIsSafe:
    def test_inside_root(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_is_root(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_outside_root(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_sibling_not_safe(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError


class TestWorkingDirTreePath:
    def test_simple_path(self, tmp_working_dir):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_nested_path(self, tmp_working_dir):
        # TODO: implement in Step 1
        raise NotImplementedError


class TestEnsureParent:
    def test_creates_parent(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError

    def test_existing_parent_no_error(self, tmp_path):
        # TODO: implement in Step 1
        raise NotImplementedError
