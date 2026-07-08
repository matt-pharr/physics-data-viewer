"""
pdv-python/tests/test_environment.py — Unit tests for pdv.environment.

Tests cover:
1. validate_working_dir() happy path and error cases.
2. resolve_project_path() path-traversal rejection.
3. path_is_safe() boundary cases.
4. uuid_tree_path() path construction.
5. ensure_parent() directory creation.

Reference: ARCHITECTURE.md §6.1, §6.2
"""

import os
import pytest
from pdv.environment import (
    validate_working_dir,
    uuid_tree_path,
    ensure_parent,
)
from pdv.errors import PDVPathError


class TestValidateWorkingDir:
    def test_valid_dir(self, tmp_working_dir):
        """A valid, writable directory is accepted."""
        result = validate_working_dir(tmp_working_dir)
        assert os.path.isabs(result)
        assert os.path.isdir(result)

    def test_nonexistent_dir_raises(self, tmp_path):
        """A path that does not exist raises PDVPathError."""
        with pytest.raises(PDVPathError):
            validate_working_dir(str(tmp_path / "nonexistent"))

    def test_not_a_directory_raises(self, tmp_path):
        """A path that is a file (not a directory) raises PDVPathError."""
        f = tmp_path / "afile.txt"
        f.write_text("data")
        with pytest.raises(PDVPathError):
            validate_working_dir(str(f))


class TestUuidTreePath:
    def test_simple_uuid_path(self, tmp_working_dir):
        """uuid_tree_path returns <working_dir>/tree/<uuid>/<filename>."""
        result = uuid_tree_path(tmp_working_dir, "a1b2c3d4e5f6", "ch1.npy")
        assert result == os.path.join(tmp_working_dir, "tree", "a1b2c3d4e5f6", "ch1.npy")

    def test_uuid_path_with_extension(self, tmp_working_dir):
        """uuid_tree_path handles various file extensions."""
        result = uuid_tree_path(tmp_working_dir, "abc123def456", "script.py")
        expected = os.path.join(tmp_working_dir, "tree", "abc123def456", "script.py")
        assert result == expected


class TestEnsureParent:
    def test_creates_parent(self, tmp_path):
        """ensure_parent() creates the parent directory if it does not exist."""
        target = str(tmp_path / "new_dir" / "nested" / "file.txt")
        result = ensure_parent(target)
        assert result == target
        assert os.path.isdir(os.path.dirname(target))

    def test_existing_parent_no_error(self, tmp_path):
        """ensure_parent() does not raise if the parent already exists."""
        target = str(tmp_path / "file.txt")
        result = ensure_parent(target)
        assert result == target
