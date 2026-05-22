"""
pdv-python/tests/test_install.py — Tests for pdv.install().

Covers the in-kernel package install path:
1. Requires a uv-managed project environment (errors clearly otherwise).
2. Runs `uv add` with the bundled binary in the working dir and refreshes
   import caches.
3. Raises on a non-zero `uv add` exit.

Reference: ARCHITECTURE.md §10.5.11
"""

from unittest.mock import MagicMock, patch

import pytest

import pdv
import pdv.comms as comms_mod
from pdv import PDVError
from pdv.tree import PDVTree


def _tree(uv_binary=None, working_dir=None):
    tree = PDVTree()
    tree._uv_binary = uv_binary
    tree._working_dir = working_dir
    return tree


def test_install_requires_uv_environment():
    """pdv.install() errors clearly outside a uv project (shared mode)."""
    tree = _tree(uv_binary=None, working_dir="/tmp/x")
    with patch.object(comms_mod, "_pdv_tree", tree):
        with pytest.raises(PDVError, match="uv-managed project environment"):
            pdv.install("numpy")


def test_install_runs_uv_add_and_invalidates_caches(tmp_path):
    """pdv.install() shells out to `uv add` and refreshes import caches."""
    tree = _tree(uv_binary="/bundled/uv", working_dir=str(tmp_path))

    proc = MagicMock()
    proc.stdout = iter(["Resolved 1 package\n", "Installed numpy\n"])
    proc.wait.return_value = 0

    with (
        patch.object(comms_mod, "_pdv_tree", tree),
        patch("subprocess.Popen", return_value=proc) as popen,
        patch("importlib.invalidate_caches") as invalidate,
    ):
        pdv.install("numpy", "scipy>=1.10")

    args, kwargs = popen.call_args
    assert args[0] == ["/bundled/uv", "add", "numpy", "scipy>=1.10"]
    assert kwargs["cwd"] == str(tmp_path)
    invalidate.assert_called_once()


def test_install_raises_on_uv_failure(tmp_path):
    """A non-zero `uv add` exit raises PDVError."""
    tree = _tree(uv_binary="/bundled/uv", working_dir=str(tmp_path))

    proc = MagicMock()
    proc.stdout = iter(["could not resolve\n"])
    proc.wait.return_value = 1

    with (
        patch.object(comms_mod, "_pdv_tree", tree),
        patch("subprocess.Popen", return_value=proc),
    ):
        with pytest.raises(PDVError, match="uv add"):
            pdv.install("nonexistent-pkg-xyz")


def test_install_no_packages_is_a_noop():
    """Calling pdv.install() with no packages does nothing and does not error."""
    tree = _tree(uv_binary="/bundled/uv", working_dir="/tmp/x")
    with (
        patch.object(comms_mod, "_pdv_tree", tree),
        patch("subprocess.Popen") as popen,
    ):
        pdv.install()
    popen.assert_not_called()
