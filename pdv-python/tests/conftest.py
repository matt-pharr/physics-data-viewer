"""
pdv-python/tests/conftest.py — pytest configuration and shared fixtures.

Provides fixtures used across all pdv test modules:

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
ARCHITECTURE.md §5 (unit tests)
"""

import os
import shutil
import tempfile
from typing import Generator
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _reset_autosave_cache() -> Generator[None, None, None]:
    """Clear the kernel's in-memory autosave cache between tests.

    The cache is module-level state in ``pdv.handlers.project`` and now
    persists across explicit saves (so unchanged data nodes can skip
    re-serialization on the next autosave). Without this fixture an
    earlier test that touches `handle_project_save` can leak cached
    descriptors into a later test and produce surprising cache hits.
    """
    from pdv.handlers.project import clear_autosave_cache

    clear_autosave_cache()
    yield
    clear_autosave_cache()


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
    """Return a PDVTree attached to mock_send, with working_dir set.

    Flushes pending debounced notifications on teardown to prevent
    timer threads from firing after the test exits.
    """
    from pdv.tree import PDVTree

    tree = PDVTree()
    tree._set_working_dir(tmp_working_dir)
    tree._attach_comm(mock_send)
    yield tree
    tree._flush_changes()
    tree._detach_comm()


@pytest.fixture()
def fresh_namespace(tree_with_comm):
    """Return a PDVNamespace with pdv_tree pre-injected."""
    from pdv.namespace import PDVNamespace

    ns = PDVNamespace()
    dict.__setitem__(ns, "pdv_tree", tree_with_comm)
    return ns


@pytest.fixture()
def mock_ipython(tree_with_comm):
    """Return a mock IPython shell with a PDVNamespace user_ns.

    The namespace already contains pdv_tree.
    """
    from pdv.namespace import PDVNamespace

    ns = PDVNamespace()
    dict.__setitem__(ns, "pdv_tree", tree_with_comm)

    ip = MagicMock()
    ip.user_ns = ns
    ip.comm_manager = MagicMock()
    return ip
