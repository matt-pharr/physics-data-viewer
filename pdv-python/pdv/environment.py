"""
pdv.environment — Path utilities and working directory management.

Centralises all filesystem path logic for pdv:

- Creating and validating the working directory (received from the app
  via ``pdv.init``).
- Resolving project-relative paths to absolute paths, with path-traversal
  protection.
- Utility helpers used by serialization.py and tree.py.

Design principle: ALL path safety checks live in this module. No other
module should perform raw ``os.path.join`` + traversal checks — they must
call functions from here.

This module has NO dependency on IPython, comms, or any Electron-facing
code. It can be imported and tested standalone.

See Also
--------
ARCHITECTURE.md §6.1 (working directory), §6.2 (save directory)
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import uuid as _uuid_mod
from pathlib import Path

from pdv.errors import PDVPathError

_NODE_UUID_RE = re.compile(r"^[0-9a-f]{12}$")


def make_working_dir(base_tmp_dir: str) -> str:
    """Create a uniquely named PDV working directory under base_tmp_dir.

    Called by the app (not the kernel) in production, but available here
    for testing. In production the app creates the directory and passes
    the path via ``pdv.init``.

    Parameters
    ----------
    base_tmp_dir : str
        Absolute path to the base temporary directory (e.g. ``/tmp``).

    Returns
    -------
    str
        Absolute path of the newly created working directory.

    Raises
    ------
    PDVPathError
        If ``base_tmp_dir`` does not exist or is not a directory.
    """
    import tempfile

    if not os.path.exists(base_tmp_dir):
        raise PDVPathError(f"Base temporary directory does not exist: {base_tmp_dir}")
    if not os.path.isdir(base_tmp_dir):
        raise PDVPathError(f"Base temporary path is not a directory: {base_tmp_dir}")
    return tempfile.mkdtemp(prefix="pdv-", dir=base_tmp_dir)


def validate_working_dir(path: str) -> str:
    """Validate that a working directory path is usable.

    Parameters
    ----------
    path : str
        Absolute path to the working directory (received from app via pdv.init).

    Returns
    -------
    str
        The validated, realpath-resolved absolute path.

    Raises
    ------
    PDVPathError
        If the path does not exist, is not a directory, or is not writable.
    """
    resolved = os.path.realpath(path)
    if not os.path.exists(resolved):
        raise PDVPathError(f"Working directory does not exist: {path}")
    if not os.path.isdir(resolved):
        raise PDVPathError(f"Working directory path is not a directory: {path}")
    if not os.access(resolved, os.W_OK):
        raise PDVPathError(f"Working directory is not writable: {path}")
    return resolved


def resolve_project_path(relative_path: str, project_root: str) -> str:
    """Resolve a project-relative path to an absolute path, rejecting traversal.

    Parameters
    ----------
    relative_path : str
        A path relative to ``project_root``. Must not be absolute and must
        not escape the project root via ``..`` components.
    project_root : str
        Absolute path to the project root directory.

    Returns
    -------
    str
        Absolute, realpath-resolved path within ``project_root``.

    Raises
    ------
    PDVPathError
        If the path is absolute, escapes the project root, or is otherwise unsafe.
    """
    if os.path.isabs(relative_path):
        raise PDVPathError(
            f"Expected a relative path, got absolute path: {relative_path}"
        )
    candidate = os.path.realpath(os.path.join(project_root, relative_path))
    root = os.path.realpath(project_root)
    if not path_is_safe(candidate, root):
        raise PDVPathError(
            f"Path '{relative_path}' escapes the project root '{project_root}'"
        )
    return candidate


def path_is_safe(candidate: str, root: str) -> bool:
    """Return True if ``candidate`` is inside ``root`` (no traversal).

    Parameters
    ----------
    candidate : str
        Absolute path to check.
    root : str
        Absolute root path.

    Returns
    -------
    bool
        True if ``candidate`` is equal to or a descendant of ``root``.
    """
    try:
        candidate_real = os.path.realpath(candidate)
        root_real = os.path.realpath(root)
        return candidate_real == root_real or candidate_real.startswith(
            root_real + os.sep
        )
    except Exception:
        return False


def working_dir_tree_path(working_dir: str, tree_path: str, extension: str) -> str:
    """Compute the absolute filesystem path for a tree node's data file.

    Maps a dot-separated tree path to a filesystem path under the working
    directory's ``tree/`` subdirectory.

    Parameters
    ----------
    working_dir : str
        Absolute path to the working directory.
    tree_path : str
        Dot-separated tree path (e.g. ``'data.waveforms.ch1'``).
    extension : str
        File extension including the dot (e.g. ``'.npy'``).

    Returns
    -------
    str
        Absolute path for the data file (parent directories are not created
        by this function).

    Example
    -------
    >>> working_dir_tree_path('/tmp/pdv-abc', 'data.waveforms.ch1', '.npy')
    '/tmp/pdv-abc/tree/data/waveforms/ch1.npy'
    """
    parts = tree_path.split(".")
    return os.path.join(working_dir, "tree", *parts[:-1], parts[-1] + extension)


def ensure_parent(path: str) -> str:
    """Create parent directories of ``path`` if they do not exist.

    Parameters
    ----------
    path : str
        Absolute path whose parent should be created.

    Returns
    -------
    str
        The input ``path`` unchanged (for chaining convenience).
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# UUID-based file storage helpers
# ---------------------------------------------------------------------------


def generate_node_uuid() -> str:
    """Generate a 12-hex-character UUID for a tree node.

    Returns
    -------
    str
        A 12-character lowercase hex string derived from UUID4.
    """
    return _uuid_mod.uuid4().hex[:12]


def uuid_tree_path(working_dir: str, node_uuid: str, filename: str) -> str:
    """Compute the absolute filesystem path for a UUID-based tree node file.

    Parameters
    ----------
    working_dir : str
        Absolute path to the working directory (or save directory).
    node_uuid : str
        The node's 12-hex-char UUID.
    filename : str
        The original filename including extension (e.g. ``'fit.py'``).

    Returns
    -------
    str
        Absolute path: ``<working_dir>/tree/<node_uuid>/<filename>``.

    Example
    -------
    >>> uuid_tree_path('/tmp/pdv-abc', 'a1b2c3d4e5f6', 'ch1.npy')
    '/tmp/pdv-abc/tree/a1b2c3d4e5f6/ch1.npy'

    Raises
    ------
    ValueError
        If *node_uuid* or *filename* contain path traversal characters.
    """
    if ".." in node_uuid or "/" in node_uuid or "\\" in node_uuid:
        raise ValueError(f"Unsafe node UUID: {node_uuid!r}")
    if ".." in filename or "/" in filename or "\\" in filename:
        raise ValueError(f"Unsafe filename: {filename!r}")
    return os.path.join(working_dir, "tree", node_uuid, filename)


def _file_xxh3(path: str) -> bytes:
    """Return the xxh3_128 digest of a file's contents."""
    import xxhash  # noqa: PLC0415

    h = xxhash.xxh3_128()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.digest()


def smart_copy(src: str, dst: str) -> None:
    """Copy a file using the fastest available method.

    If *dst* already exists and is byte-identical to *src* (verified via
    xxh3_128), the copy is skipped. If *dst* exists but differs, it is
    replaced.

    Attempts copy-on-write cloning first, falling back to a regular copy.

    1. Python 3.14+ ``pathlib.Path.copy()`` (OS-level CoW on APFS, btrfs,
       XFS, ZFS, etc.).
    2. ``reflink_copy.reflink_or_copy()`` (optional dependency, Rust-backed).
    3. ``shutil.copy2()`` (universal fallback, preserves metadata).

    Parent directories of *dst* are created automatically.

    Parameters
    ----------
    src : str
        Absolute path to the source file.
    dst : str
        Absolute path to the destination file.
    """
    ensure_parent(dst)

    if os.path.exists(dst):
        if os.path.getsize(src) == os.path.getsize(dst) and _file_xxh3(src) == _file_xxh3(dst):
            return
        os.remove(dst)

    if hasattr(Path, "copy"):
        Path(src).copy(Path(dst))
        return

    try:
        from reflink_copy import reflink_or_copy  # noqa: PLC0415

        reflink_or_copy(src, dst)
        return
    except ImportError:
        pass
    except OSError as exc:
        logging.getLogger("pdv").warning(
            "reflink_or_copy failed for %s -> %s: %s; falling back to shutil.copy2",
            src, dst, exc,
        )

    shutil.copy2(src, dst)
