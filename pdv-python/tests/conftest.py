"""
pdv-python/tests/conftest.py — pytest configuration and shared fixtures.

Provides fixtures used across all pdv_kernel test modules:

- ``tmp_working_dir``: a freshly created temporary working directory
  (cleaned up after the test).
- ``tmp_save_dir``: a separate directory for project save output.
- ``mock_send``: a callable that captures outgoing comm messages.
- ``tree_with_comm``: a :class:`PDVTree` instance with the mock send
  function attached (so mutations emit notifications to ``mock_send``).
- ``fresh_namespace``: a :class:`PDVNamespace` with ``pdv_tree`` and
  ``pdv`` pre-injected.

See Also
--------
ARCHITECTURE.md §5 (package structure overview)
IMPLEMENTATION_STEPS.md Step 1 (unit tests)
"""

import os
import shutil
import tempfile
from typing import Generator
from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def tmp_working_dir() -> Generator[str, None, None]:
    """Yield a freshly created temporary working directory.

    The directory is deleted after the test, even if it fails.
    """
    d = tempfile.mkdtemp(prefix="pdv-test-work-")
    yield os.path.realpath(d)
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture()
def tmp_save_dir() -> Generator[str, None, None]:
    """Yield a freshly created temporary project save directory."""
    d = tempfile.mkdtemp(prefix="pdv-test-save-")
    yield os.path.realpath(d)
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture()
def mock_send() -> MagicMock:
    """Return a MagicMock that captures outgoing comm messages.

    Usage::

        def test_something(mock_send):
            tree._attach_comm(mock_send)
            tree['x'] = 1
            mock_send.assert_called_once()
            call_type, call_payload = mock_send.call_args[0]
            assert call_type == 'pdv.tree.changed'
    """
    return MagicMock()


@pytest.fixture()
def tree_with_comm(tmp_working_dir, mock_send):
    """Return a PDVTree attached to mock_send, with working_dir set."""
    from pdv_kernel.tree import PDVTree

    tree = PDVTree()
    tree._set_working_dir(tmp_working_dir)
    tree._attach_comm(mock_send)
    return tree


@pytest.fixture()
def fresh_namespace(tree_with_comm):
    """Return a PDVNamespace with pdv_tree and pdv pre-injected."""
    from pdv_kernel.namespace import PDVApp, PDVNamespace

    ns = PDVNamespace()
    dict.__setitem__(ns, "pdv_tree", tree_with_comm)
    dict.__setitem__(ns, "pdv", PDVApp())
    return ns


@pytest.fixture()
def mock_ipython(tree_with_comm):
    """Return a mock IPython shell with a PDVNamespace user_ns.

    The namespace already contains pdv_tree and pdv.
    """
    from pdv_kernel.namespace import PDVApp, PDVNamespace

    ns = PDVNamespace()
    dict.__setitem__(ns, "pdv_tree", tree_with_comm)
    dict.__setitem__(ns, "pdv", PDVApp())

    ip = MagicMock()
    ip.user_ns = ns
    ip.comm_manager = MagicMock()
    return ip
