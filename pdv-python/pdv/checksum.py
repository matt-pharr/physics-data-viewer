"""
pdv.checksum — Content-based Merkle-tree checksum for PDVTree.

Computes a canonical, content-based XXH3-128 checksum directly from the
in-memory PDVTree. The checksum is:
- Independent of serialization order and timestamps
- Recursively callable on any sub-tree (Merkle-tree structure)
- Stable across save/load round-trips

File-backed nodes (PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib) are
hashed including their file content. Missing files feed a sentinel value
rather than raising, so partial sub-tree hashes work during debugging.

XXH3-128 is a non-cryptographic hash used purely for change detection.
It is not suitable for security purposes.

This module has NO dependency on IPython, comms, or any Electron-facing
code. It can be imported and tested standalone.

See Also
--------
ARCHITECTURE.md §7.2 (node types)
"""

from __future__ import annotations

import struct
from typing import Any

import xxhash


def tree_checksum(node: Any, working_dir: str | None = None) -> str:
    """Return a 32-character hex XXH3-128 digest for a PDVTree node or any
    sub-tree node.

    If ``node`` is a PDVTree and ``working_dir`` is None, ``node._working_dir``
    is used automatically. Pass ``working_dir`` explicitly when calling on a
    child PDVTree that does not have ``_working_dir`` set.

    File-backed nodes (PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib) are
    hashed including their file content, read from disk via
    ``node.resolve_path(working_dir)``. If the file is missing or
    ``working_dir`` is None, the sentinel bytes ``b"<missing_file>"`` are fed
    rather than raising, so partial sub-tree hashes still work during
    debugging.

    Parameters
    ----------
    node : Any
        The tree node to hash.
    working_dir : str or None
        Working directory for resolving file-backed node paths. If None and
        ``node`` is a PDVTree, ``node._working_dir`` is used.

    Returns
    -------
    str
        32-character lowercase hex XXH3-128 digest.
    """
    from pdv.tree import PDVTree  # noqa: PLC0415

    if working_dir is None and isinstance(node, PDVTree):
        working_dir = getattr(node, "_working_dir", None)
    h = xxhash.xxh3_128()
    _feed_node(h, node, working_dir)
    return h.hexdigest()


def node_digest(node: Any, working_dir: str | None) -> bytes:
    """Return the 16-byte XXH3-128 digest for a single node.

    Parameters
    ----------
    node : Any
        The tree node to hash.
    working_dir : str or None
        Working directory for resolving file paths.

    Returns
    -------
    bytes
        16-byte raw digest.
    """
    h = xxhash.xxh3_128()
    _feed_node(h, node, working_dir)
    return h.digest()


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _feed_node(h: xxhash.xxh3_128, node: Any, working_dir: str | None) -> None:
    """Feed the canonical byte representation of ``node`` into hasher ``h``.

    Dispatches on ``detect_kind(node)``. Every branch begins with a
    null-terminated ASCII type tag so no two kinds collide even if their
    content bytes match.

    Parameters
    ----------
    h : hashlib._Hash
        The running SHA-256 hasher.
    node : Any
        The value to encode.
    working_dir : str or None
        Working directory for file-backed nodes.
    """
    from pdv.serialization import (  # noqa: PLC0415
        detect_kind,
        KIND_FOLDER,
        KIND_MODULE,
        KIND_SCALAR,
        KIND_TEXT,
        KIND_BINARY,
        KIND_MAPPING,
        KIND_SEQUENCE,
        KIND_NDARRAY,
        KIND_DATAFRAME,
        KIND_SERIES,
        KIND_DATASET,
        KIND_DATAARRAY,
        KIND_SCRIPT,
        KIND_MARKDOWN,
        KIND_GUI,
        KIND_NAMELIST,
        KIND_LIB,
    )

    kind = detect_kind(node)

    if kind == KIND_FOLDER:
        h.update(b"folder\x00")
        sorted_keys = sorted(dict.keys(node))
        h.update(struct.pack("<Q", len(sorted_keys)))
        for key in sorted_keys:
            _feed_str(h, key)
            child = dict.__getitem__(node, key)
            h.update(node_digest(child, working_dir))

    elif kind == KIND_MODULE:
        h.update(b"module\x00")
        _feed_str(h, node.module_id)
        _feed_str(h, node.name)
        _feed_str(h, node.version)
        sorted_keys = sorted(dict.keys(node))
        h.update(struct.pack("<Q", len(sorted_keys)))
        for key in sorted_keys:
            _feed_str(h, key)
            child = dict.__getitem__(node, key)
            h.update(node_digest(child, working_dir))

    elif kind == KIND_SCALAR:
        if node is None:
            h.update(b"scalar\x00null\x00")
        elif isinstance(node, bool):
            h.update(b"scalar\x00bool\x00")
            h.update(b"\x01" if node else b"\x00")
        elif isinstance(node, int):
            h.update(b"scalar\x00int\x00")
            _feed_str(h, str(node))
        elif isinstance(node, complex):
            h.update(b"scalar\x00complex\x00")
            h.update(struct.pack("<dd", node.real, node.imag))
        else:  # float
            h.update(b"scalar\x00float\x00")
            h.update(struct.pack("<d", node))

    elif kind == KIND_TEXT:
        h.update(b"text\x00")
        _feed_str(h, node)

    elif kind == KIND_BINARY:
        h.update(b"binary\x00")
        h.update(struct.pack("<Q", len(node)))
        h.update(bytes(node))

    elif kind == KIND_MAPPING:
        h.update(b"mapping\x00")
        sorted_keys = sorted(node.keys(), key=str)
        h.update(struct.pack("<Q", len(sorted_keys)))
        for key in sorted_keys:
            _feed_str(h, str(key))
            _feed_node(h, node[key], working_dir)

    elif kind == KIND_SEQUENCE:
        # Type-tag the concrete sequence flavor so a regression that swaps
        # tuple ↔ list (or set ↔ frozenset) produces a different digest.
        if isinstance(node, tuple):
            h.update(b"sequence\x00tuple\x00")
            items = node
        elif isinstance(node, frozenset):
            h.update(b"sequence\x00frozenset\x00")
            items = sorted(node, key=repr)
        elif isinstance(node, set):
            h.update(b"sequence\x00set\x00")
            # Sets are unordered; sort by repr for a deterministic digest so
            # autosave doesn't flag unchanged sets as dirty across runs.
            items = sorted(node, key=repr)
        else:  # list
            h.update(b"sequence\x00list\x00")
            items = node
        h.update(struct.pack("<Q", len(node)))
        for item in items:
            _feed_node(h, item, working_dir)

    elif kind == KIND_NDARRAY:
        import numpy as np  # noqa: PLC0415

        h.update(b"ndarray\x00")
        _feed_str(h, str(node.dtype))
        h.update(struct.pack("<Q", len(node.shape)))
        for d in node.shape:
            h.update(struct.pack("<Q", d))
        # Feed array data directly via the buffer protocol — avoids a full
        # tobytes() copy. np.ascontiguousarray is a zero-allocation no-op for
        # arrays that are already C-contiguous (the typical case).
        h.update(np.ascontiguousarray(node))

    elif kind == KIND_DATAFRAME:
        import numpy as np  # noqa: PLC0415

        h.update(b"dataframe\x00")
        cols = list(node.columns)
        h.update(struct.pack("<Q", len(cols)))
        for col in cols:
            _feed_str(h, col)
            col_vals = node[col].values
            _feed_str(h, str(col_vals.dtype))
            if col_vals.dtype.kind in ("f", "i", "u", "c", "b"):
                h.update(np.ascontiguousarray(col_vals))
            else:
                _feed_str(h, repr(node[col].tolist()))

    elif kind == KIND_SERIES:
        import numpy as np  # noqa: PLC0415

        h.update(b"series\x00")
        series_vals = node.values
        _feed_str(h, str(series_vals.dtype))
        if series_vals.dtype.kind in ("f", "i", "u", "c", "b"):
            h.update(np.ascontiguousarray(series_vals))
        else:
            _feed_str(h, repr(node.tolist()))

    elif kind == KIND_DATAARRAY:
        h.update(b"dataarray\x00")
        _feed_xarray_array(
            h, str(node.name) if node.name is not None else "", node
        )
        coord_names = sorted(node.coords, key=str)
        h.update(struct.pack("<Q", len(coord_names)))
        for cname in coord_names:
            _feed_xarray_array(h, str(cname), node.coords[cname])

    elif kind == KIND_DATASET:
        h.update(b"dataset\x00")
        var_names = sorted(node.data_vars, key=str)
        h.update(struct.pack("<Q", len(var_names)))
        for vname in var_names:
            _feed_xarray_array(h, str(vname), node[vname])
        coord_names = sorted(node.coords, key=str)
        h.update(struct.pack("<Q", len(coord_names)))
        for cname in coord_names:
            _feed_xarray_array(h, str(cname), node.coords[cname])
        attr_keys = sorted(node.attrs.keys(), key=str)
        h.update(struct.pack("<Q", len(attr_keys)))
        for key in attr_keys:
            _feed_str(h, str(key))
            _feed_str(h, repr(node.attrs[key]))

    # ------------------------------------------------------------------
    # File-backed nodes intentionally do NOT hash ``relative_path``:
    # it is a storage-layout detail that drifts across save/load cycles
    # (serialize_node writes PDVScript/PDVNote/PDVGui/PDVNamelist files
    # under ``<save_dir>/tree/...`` but does not mutate the in-memory
    # node, so the post-load ``relative_path`` gains a ``tree/`` prefix
    # the pre-save one lacks). File content is still fed in full via
    # ``_feed_file_content``, and the parent folder's key iteration
    # already folds the tree path into the digest, so the checksum
    # stays sensitive to everything that actually defines node
    # identity — just not to where on disk the backing file lives.
    # ------------------------------------------------------------------
    elif kind == KIND_SCRIPT:
        h.update(b"script\x00")
        _feed_str(h, node.language)
        _feed_file_content(h, node, working_dir)

    elif kind == KIND_MARKDOWN:
        h.update(b"note\x00")
        _feed_file_content(h, node, working_dir)

    elif kind == KIND_GUI:
        h.update(b"gui\x00")
        _feed_file_content(h, node, working_dir)

    elif kind == KIND_NAMELIST:
        h.update(b"namelist\x00")
        _feed_str(h, node.format)
        _feed_file_content(h, node, working_dir)

    elif kind == KIND_LIB:
        h.update(b"lib\x00")
        _feed_file_content(h, node, working_dir)

    else:  # KIND_UNKNOWN (and KIND_FILE base class, if encountered)
        h.update(b"unknown\x00")
        _feed_str(h, repr(node))


def _feed_xarray_array(h: xxhash.xxh3_128, name: str, da: Any) -> None:
    """Feed the bare content of an xarray.DataArray (name, dims, dtype,
    shape, raw values, attrs) into ``h``. Coordinates are *not* recursed
    into here — callers hash coords as a separate, flat sequence so a
    Dataset's shared coords are fed once instead of once per data_var.
    """
    import numpy as np  # noqa: PLC0415

    _feed_str(h, name)
    h.update(struct.pack("<Q", len(da.dims)))
    for dim in da.dims:
        _feed_str(h, str(dim))
    _feed_str(h, str(da.dtype))
    h.update(struct.pack("<Q", len(da.shape)))
    for d in da.shape:
        h.update(struct.pack("<Q", d))
    values = np.asarray(da.values)
    # datetime64/timedelta64 ('M'/'m') are fixed-width and expose a buffer,
    # so they take the fast path alongside the plain numeric kinds — xarray
    # time coordinates are common and can be large. Only genuinely
    # buffer-less dtypes (object, str, ...) fall back to repr().
    if values.dtype.kind in ("f", "i", "u", "c", "b", "M", "m"):
        h.update(np.ascontiguousarray(values))
    else:
        _feed_str(h, repr(values.tolist()))
    attr_keys = sorted(da.attrs.keys(), key=str)
    h.update(struct.pack("<Q", len(attr_keys)))
    for key in attr_keys:
        _feed_str(h, str(key))
        _feed_str(h, repr(da.attrs[key]))


def _feed_str(h: xxhash.xxh3_128, s: str) -> None:
    """Feed a length-prefixed UTF-8 string into ``h``.

    Parameters
    ----------
    h : hashlib._Hash
        The running SHA-256 hasher.
    s : str
        String to encode.
    """
    encoded = s.encode("utf-8")
    h.update(struct.pack("<Q", len(encoded)))
    h.update(encoded)


def _feed_file_content(
    h: xxhash.xxh3_128,
    node: Any,
    working_dir: str | None,
) -> None:
    """Stream file content into ``h`` in 64 KiB chunks.

    If the file is missing or ``working_dir`` is None, feed the sentinel bytes
    ``b"<missing_file>"`` so partial sub-tree hashes still work during
    debugging.

    Parameters
    ----------
    h : hashlib._Hash
        The running SHA-256 hasher.
    node : PDVFile
        A file-backed node with a ``resolve_path()`` method.
    working_dir : str or None
        Working directory for resolving the file path.
    """
    import os  # noqa: PLC0415

    if working_dir is None:
        h.update(b"<missing_file>")
        return

    abs_path = node.resolve_path(working_dir)
    if not os.path.exists(abs_path):
        h.update(b"<missing_file>")
        return

    try:
        with open(abs_path, "rb") as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                h.update(chunk)
    except OSError:
        h.update(b"<missing_file>")
