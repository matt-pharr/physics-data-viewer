"""
pdv.environment — Path utilities and working directory management.

Centralises all filesystem path logic for pdv:

- Validating the working directory (received from the app via
  ``pdv.init``) and owning the kernel-CWD policy
  (:func:`reset_cwd_to_home`).
- UUID-based node storage paths (:func:`uuid_tree_path`,
  :func:`generate_node_uuid`) and copy helpers (:func:`smart_copy`).

Design principle: ALL path construction and validation lives in this
module. No other module should perform raw ``os.path.join`` against
working/save directories — they must call functions from here.

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


def reset_cwd_to_home() -> None:
    """Point the kernel process's CWD at the user's home directory.

    PDV deliberately keeps the process CWD out of both the ephemeral
    working directory and the project save directory: relative paths in
    user code should resolve somewhere durable and predictable, not into
    a session temp dir that is deleted on stop (or a save dir the user
    may move). This is the single home for that policy — called after
    ``pdv.init`` (session start) and again after every project load,
    which would otherwise leave the CWD wherever the previous session or
    OS default put it.

    Failures are swallowed: an unreadable home directory must not break
    kernel init or project load.
    """
    try:
        os.chdir(os.path.expanduser("~"))
    except OSError:
        logging.getLogger("pdv").warning(
            "Could not chdir to home directory; CWD left unchanged."
        )


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
    """Copy a file using the fastest available method, atomically.

    The copy is staged at a sibling ``<dst>.tmp`` and then renamed onto
    *dst* via :func:`os.replace`. POSIX guarantees the rename is atomic
    when source and destination are on the same volume — which is
    always the case here because the temp is a sibling of *dst*. A
    crash mid-copy therefore leaves *dst* either untouched (if the
    rename hadn't happened) or fully-new; never torn. This is the
    invariant that file-backed PDV nodes (PDVScript, PDVNote, PDVLib,
    PDVGui, PDVNamelist, PDVFile) rely on for crash-safe in-place
    overwrites: they reuse a stable UUID across saves and so the
    canonical path is the same each save.

    If *dst* already exists and is byte-identical to *src* (verified
    via xxh3_128), the copy is skipped entirely with no I/O.

    The underlying copy attempts copy-on-write cloning first, falling
    back to a regular copy:

    1. Python 3.14+ :meth:`pathlib.Path.copy` (OS-level CoW on APFS,
       btrfs, XFS, ZFS, etc.).
    2. :func:`reflink_copy.reflink_or_copy` (optional dependency,
       Rust-backed).
    3. :func:`shutil.copy2` (universal fallback, preserves metadata).

    Stale ``<dst>.tmp`` from a prior crash is unlinked at the top of
    the copy attempt. The in-process ``BaseException`` cleanup at the
    end only covers crashes the process notices; an external
    ``SIGKILL`` or power loss leaves the temp behind, so the next
    save's fast-path-skip case would otherwise let it linger.
    ``Path.copy`` (3.14+) is documented to overwrite by default, and
    both ``reflink_or_copy`` and ``shutil.copy2`` overwrite by default,
    so the unlink is belt-and-suspenders — but it also keeps the save
    directory tidy.

    Concurrency note: the tmp name is deterministic (``<dst>.tmp``).
    Today PDV serializes saves through the kernel, so only one writer
    is in flight for a given path at a time. If multi-window / Session
    work ever introduces two concurrent writers targeting the same
    UUID file, the tmp name will need a per-writer suffix to avoid
    collision; see ``project_multi_window`` notes.

    Parent directories of *dst* are created automatically when a write
    is actually needed (fast-path-skip skips the ``mkdir`` too).

    Parameters
    ----------
    src : str
        Absolute path to the source file.
    dst : str
        Absolute path to the destination file.

    Raises
    ------
    OSError
        Propagates errors from the underlying copy primitives. The
        sibling ``<dst>.tmp`` is removed before the error propagates,
        and *dst* itself is never modified on failure.
    """
    tmp = dst + ".tmp"
    # Sweep any stale temp left by a previous crashed save *before*
    # the fast-path check, so a byte-identical save still cleans up
    # after a prior SIGKILL or power loss. One extra `unlink` syscall
    # per call is a small price for not accumulating tmp detritus in
    # the save directory across crashed runs. All three underlying
    # primitives below also overwrite an existing tmp, so this is
    # belt-and-suspenders for the actual-write path.
    try:
        os.remove(tmp)
    except FileNotFoundError:
        pass
    except OSError:
        # Permission failure on cleanup: let the copy attempt below
        # surface a clearer error from the actual write path.
        pass

    # Fast-path: identical destination — skip the rest of the I/O.
    if os.path.exists(dst):
        if os.path.getsize(src) == os.path.getsize(dst) and _file_xxh3(src) == _file_xxh3(dst):
            return

    ensure_parent(dst)
    try:
        if hasattr(Path, "copy"):
            Path(src).copy(Path(tmp))
        else:
            copied = False
            try:
                from reflink_copy import reflink_or_copy  # noqa: PLC0415

                reflink_or_copy(src, tmp)
                copied = True
            except ImportError:
                pass
            except OSError as exc:
                logging.getLogger("pdv").warning(
                    "reflink_or_copy failed for %s -> %s: %s; falling back to shutil.copy2",
                    src, tmp, exc,
                )
            if not copied:
                shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    except BaseException:
        # Clean up the temp on any failure (including KeyboardInterrupt
        # and SystemExit) so the save dir doesn't accumulate `.tmp`
        # detritus across in-process failures.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
