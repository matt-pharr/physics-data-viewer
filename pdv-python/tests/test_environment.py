"""
pdv-python/tests/test_environment.py — Unit tests for pdv.environment.

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
from pdv.environment import (
    validate_working_dir,
    resolve_project_path,
    path_is_safe,
    working_dir_tree_path,
    uuid_tree_path,
    ensure_parent,
    make_working_dir,
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


class TestResolveProjectPath:
    def test_simple_relative_path(self, tmp_save_dir):
        """A simple relative path resolves correctly."""
        result = resolve_project_path("subdir/file.txt", tmp_save_dir)
        assert result.startswith(tmp_save_dir)
        assert result.endswith("file.txt")

    def test_nested_relative_path(self, tmp_save_dir):
        """A nested relative path resolves correctly."""
        result = resolve_project_path("a/b/c.npy", tmp_save_dir)
        assert result.startswith(tmp_save_dir)
        assert "a" in result and "b" in result

    def test_traversal_rejected(self, tmp_save_dir):
        """A path with '../' must raise PDVPathError."""
        with pytest.raises(PDVPathError):
            resolve_project_path("../escape.txt", tmp_save_dir)

    def test_absolute_path_rejected(self, tmp_save_dir):
        """An absolute path must raise PDVPathError."""
        with pytest.raises(PDVPathError):
            resolve_project_path("/etc/passwd", tmp_save_dir)


class TestPathIsSafe:
    def test_inside_root(self, tmp_path):
        """A path inside root is safe."""
        child = str(tmp_path / "subdir" / "file.txt")
        assert path_is_safe(child, str(tmp_path)) is True

    def test_is_root(self, tmp_path):
        """The root itself is safe."""
        assert path_is_safe(str(tmp_path), str(tmp_path)) is True

    def test_outside_root(self, tmp_path):
        """A path outside root is not safe."""
        parent = str(tmp_path.parent)
        assert path_is_safe(parent, str(tmp_path)) is False

    def test_sibling_not_safe(self, tmp_path):
        """A sibling directory with a matching prefix is not safe."""
        # Create a sibling: if tmp_path is /tmp/abc, sibling is /tmp/abcXXX
        sibling = str(tmp_path) + "_sibling"
        assert path_is_safe(sibling, str(tmp_path)) is False

    def test_traversal_attempt_not_safe(self, tmp_path):
        """A path built with .. that escapes the root is not safe."""
        # Construct a path that would escape via traversal before realpath
        attempt = os.path.join(str(tmp_path), "..", "outside")
        assert path_is_safe(attempt, str(tmp_path)) is False


class TestWorkingDirTreePath:
    def test_simple_path(self, tmp_working_dir):
        """A simple one-part tree path maps correctly."""
        result = working_dir_tree_path(tmp_working_dir, "x", ".npy")
        assert result == os.path.join(tmp_working_dir, "tree", "x.npy")

    def test_nested_path(self, tmp_working_dir):
        """A three-part tree path maps to the correct nested structure."""
        result = working_dir_tree_path(tmp_working_dir, "data.waveforms.ch1", ".npy")
        expected = os.path.join(tmp_working_dir, "tree", "data", "waveforms", "ch1.npy")
        assert result == expected


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


class TestMakeWorkingDir:
    def test_creates_directory(self, tmp_path):
        """make_working_dir creates a new directory under the base."""
        result = make_working_dir(str(tmp_path))
        assert os.path.isdir(result)
        assert result.startswith(str(tmp_path))

    def test_prefix_is_pdv(self, tmp_path):
        """Created directory name starts with 'pdv-'."""
        result = make_working_dir(str(tmp_path))
        assert os.path.basename(result).startswith("pdv-")

    def test_nonexistent_base_raises(self, tmp_path):
        """A non-existent base directory raises PDVPathError."""
        with pytest.raises(PDVPathError):
            make_working_dir(str(tmp_path / "nonexistent"))
