"""
pdv.serialization — Type detection and format readers/writers.

Handles all conversion between in-memory Python values and on-disk
file representations.

Supported formats
-----------------
- **npy** — NumPy arrays (requires numpy)
- **pickle** — Pandas DataFrame and Series (PDV saves are internal)
- **json** — JSON-native scalars, lists, dicts
- **txt** — Plain text strings
- **pickle** — Fallback for unknown types (only when ``trusted=True``)

Design notes
------------
- numpy and pandas are imported lazily inside functions so that the
  package can be imported without them installed.
- ``detect_kind`` returns one of the kind strings defined in
  ARCHITECTURE.md §7.2.
- ``serialize_node`` writes the data file and returns a node descriptor
  dict (matching ARCHITECTURE.md §7.3).
- ``deserialize_node`` reads a storage reference dict and returns the
  in-memory value.

This module has NO dependency on IPython, comms, or any Electron-facing
code. It can be imported and tested standalone.

See Also
--------
ARCHITECTURE.md §7.2 (node types), §7.3 (node descriptor)
"""

from __future__ import annotations

import math
from typing import Any

from pdv.errors import PDVSerializationError


# Node kind strings — must match ARCHITECTURE.md §7.2
KIND_FOLDER = "folder"
KIND_SCRIPT = "script"
KIND_NDARRAY = "ndarray"
KIND_DATAFRAME = "dataframe"
KIND_SERIES = "series"
KIND_SCALAR = "scalar"
KIND_TEXT = "text"
KIND_MAPPING = "mapping"
KIND_SEQUENCE = "sequence"
KIND_MARKDOWN = "markdown"
KIND_BINARY = "binary"
KIND_MODULE = "module"
KIND_GUI = "gui"
KIND_NAMELIST = "namelist"
KIND_LIB = "lib"
KIND_FILE = "file"
KIND_DATASET = "dataset"
KIND_DATAARRAY = "dataarray"
KIND_UNKNOWN = "unknown"

# Format strings — must match ARCHITECTURE.md §7.3 storage.format
FORMAT_NPY = "npy"
FORMAT_JSON = "json"
FORMAT_TXT = "txt"
FORMAT_PICKLE = "pickle"
FORMAT_PY_SCRIPT = "py_script"
FORMAT_MARKDOWN = "markdown"
FORMAT_INLINE = "inline"
FORMAT_GUI_JSON = "gui_json"
FORMAT_MODULE_META = "module_meta"
FORMAT_NAMELIST = "namelist"
FORMAT_PY_LIB = "py_lib"
FORMAT_FILE = "file"

# Directory-name convention for the autosave sibling under a save dir.
# Centralized here so `_verify_or_relocate_cached_file` and any future
# reconciliation paths agree on the heuristic. Mirrors `autosaveDirFor`
# in `electron/main/autosave-sidecars.ts`.
AUTOSAVE_DIR_NAME = ".autosave"


def _can_inline_json(value: Any) -> bool:
    """Return True if ``value`` round-trips losslessly through JSON.

    Stricter than "json.dumps doesn't raise": rejects tuples (collapsed to
    arrays), sets/frozensets, complex, bytes, and any value at any nesting
    level whose Python type can't be reconstructed from JSON. Only str /
    int / float / bool / None scalars and lists/dicts (with str keys)
    composed of those are considered inline-safe.

    Used by :func:`serialize_node` to decide between the fast inline path
    and the composite/pickle paths that preserve type fidelity.
    """
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        # NaN/inf serialize as bare ``NaN``/``Infinity`` tokens, which are
        # invalid JSON — JSON.parse on the app side would reject the whole
        # tree-index.json. Route non-finite floats to the pickle path.
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_can_inline_json(v) for v in value)
    if isinstance(value, dict):
        return all(
            isinstance(k, str) and _can_inline_json(v) for k, v in value.items()
        )
    return False


def is_xarray_dataset(value: Any) -> bool:
    """Return True if ``value`` is an xarray ``Dataset``.

    Reads ``sys.modules`` instead of doing ``import xarray`` so this helper
    is safe to call from the QueryServer thread while the main kernel
    thread is unpickling Dataset objects during project load. xarray's
    first import is not safe to drive concurrently from multiple threads
    and races produce "partially initialized module" errors. If xarray
    isn't already imported, ``value`` cannot be a Dataset, so returning
    False is correct (any real Dataset would have caused xarray to be
    imported by the code that constructed it).
    """
    import sys  # noqa: PLC0415

    xr = sys.modules.get("xarray")
    if xr is None:
        return False
    return isinstance(value, xr.Dataset)


def is_xarray_dataarray(value: Any) -> bool:
    """Return True if ``value`` is an xarray ``DataArray``.

    See :func:`is_xarray_dataset` for why this checks ``sys.modules``
    rather than importing xarray.
    """
    import sys  # noqa: PLC0415

    xr = sys.modules.get("xarray")
    if xr is None:
        return False
    return isinstance(value, xr.DataArray)


def _is_xarray_object(value: Any) -> bool:
    """Return True if ``value`` is an xarray DataArray or Dataset.

    Used by :func:`serialize_node` to route xarray nodes to builtin pickle
    storage, bypassing the custom-serializer registry. First-class xarray
    support with a more inspectable on-disk format is planned for beta;
    until then pickle is the simplest reliable round-trip.
    """
    return is_xarray_dataset(value) or is_xarray_dataarray(value)


def _has_array_leaf(value: Any) -> bool:
    """Return True if ``value`` or any nested value is an ndarray, DataFrame, or Series.

    Used by the sequence-serialization path to choose between pickling the
    whole container (safe for tuples/sets/complex/bytes leaves) and raising
    a "split into a dict" error (when an array leaf is present and would
    need its own file for fast access).
    """
    try:
        import numpy as np  # noqa: PLC0415

        if isinstance(value, np.ndarray):
            return True
    except ImportError:
        pass
    try:
        import pandas as pd  # noqa: PLC0415

        if isinstance(value, (pd.DataFrame, pd.Series)):
            return True
    except ImportError:
        pass
    if isinstance(value, dict):
        return any(_has_array_leaf(v) for v in value.values())
    if isinstance(value, (list, tuple, set, frozenset)):
        return any(_has_array_leaf(v) for v in value)
    return False


def python_type_string(value: Any) -> str:
    """Return ``'module.qualname'`` for any object.

    Parameters
    ----------
    value : Any
        Any Python object.

    Returns
    -------
    str
        Fully qualified type string, e.g. ``'builtins.int'``.
    """
    t = type(value)
    return f"{t.__module__}.{t.__qualname__}"


def detect_kind(value: Any) -> str:
    """Detect the node kind for a Python value.

    Parameters
    ----------
    value : Any
        Any Python object.

    Returns
    -------
    str
        One of the ``KIND_*`` constants defined in this module, matching
        the node types in ARCHITECTURE.md §7.2.

    Notes
    -----
    numpy and pandas are imported lazily — if they are not installed,
    ndarray/dataframe/series values fall through to ``KIND_UNKNOWN``.
    """
    # Lazy import to avoid circular dependency and optional deps
    from pdv.tree import (
        PDVTree,
        PDVScript,
        PDVNote,
        PDVFile,
        PDVModule,
        PDVGui,
        PDVNamelist,
        PDVLib,
    )  # noqa: PLC0415

    if isinstance(value, PDVModule):
        return KIND_MODULE
    if isinstance(value, PDVTree):
        return KIND_FOLDER
    if isinstance(value, PDVFile):
        if isinstance(value, PDVScript):
            return KIND_SCRIPT
        if isinstance(value, PDVNote):
            return KIND_MARKDOWN
        if isinstance(value, PDVGui):
            return KIND_GUI
        if isinstance(value, PDVNamelist):
            return KIND_NAMELIST
        if isinstance(value, PDVLib):
            return KIND_LIB
        return KIND_FILE
    # bool must be checked before int (bool is a subclass of int)
    if isinstance(value, bool):
        return KIND_SCALAR
    if isinstance(value, (int, float, complex)) or value is None:
        return KIND_SCALAR
    if isinstance(value, str):
        return KIND_TEXT
    if isinstance(value, (bytes, bytearray)):
        return KIND_BINARY
    if isinstance(value, dict):
        return KIND_MAPPING
    # Sets are unordered, but classifying them under the sequence kind
    # keeps the renderer treatment (collection chip, sized preview)
    # consistent with list/tuple. The Python class shown in the chip
    # (`set` / `frozenset`) tells users they're not lists.
    if isinstance(value, (list, tuple, set, frozenset)):
        return KIND_SEQUENCE
    # xarray comes before numpy because DataArray wraps an ndarray and we
    # want the richer kind. Both helpers are no-ops when xarray isn't
    # installed.
    if is_xarray_dataset(value):
        return KIND_DATASET
    if is_xarray_dataarray(value):
        return KIND_DATAARRAY
    # Lazy numpy/pandas checks
    try:
        import numpy as np  # noqa: PLC0415

        if isinstance(value, np.ndarray):
            return KIND_NDARRAY
    except ImportError:
        pass
    try:
        import pandas as pd  # noqa: PLC0415

        if isinstance(value, pd.DataFrame):
            return KIND_DATAFRAME
        if isinstance(value, pd.Series):
            return KIND_SERIES
    except ImportError:
        pass
    return KIND_UNKNOWN


def _verify_or_relocate_cached_file(
    descriptor: dict,
    working_dir: str,
) -> bool:
    """Make a cache-hit descriptor's backing file reachable under ``working_dir``.

    The autosave cache stores ``(digest, descriptor)`` pairs whose
    ``storage.uuid`` was minted by whichever serialize call wrote the file.
    For an autosave miss the file lands in ``<saveDir>/.autosave/tree/<uuid>/``;
    for an explicit-save miss it lands in ``<saveDir>/tree/<uuid>/``. When the
    *next* save sees a cache hit, the descriptor's UUID is reused verbatim —
    but the file may not be where the new ``tree-index.json`` is going to claim
    it is.

    This helper closes that gap. For a file-backed descriptor it:

    1. Returns True if the file is already at ``<working_dir>/tree/<uuid>/<filename>``.
    2. Otherwise tries the sibling autosave dir (``<working_dir>/.autosave/...``)
       and moves the file into the canonical location via ``os.replace`` —
       same-volume rename is effectively free, so this is the cheap path that
       lets an explicit save adopt files left behind by an autosave.
    3. If ``working_dir`` itself ends in ``.autosave``, treats the parent's
       ``tree/<uuid>/`` as a valid home too (a previous explicit save's file).
       In that case no move happens — autosave recovery's overlay handles it.
    4. Otherwise returns False so the caller falls through to re-serialize.

    Inline (``backend != "local_file"``) descriptors are always valid.
    """
    import os  # noqa: PLC0415

    storage = descriptor.get("storage", {})
    if storage.get("backend") != "local_file":
        return True
    node_uuid = storage.get("uuid")
    filename = storage.get("filename")
    if not node_uuid or not filename:
        return True

    from pdv.environment import ensure_parent, uuid_tree_path  # noqa: PLC0415

    canonical = uuid_tree_path(working_dir, node_uuid, filename)
    if os.path.exists(canonical):
        return True

    working_norm = working_dir.rstrip(os.sep)
    is_autosave_dir = os.path.basename(working_norm) == AUTOSAVE_DIR_NAME

    if not is_autosave_dir:
        # Explicit save: file may have been written by a previous autosave.
        # Same-volume rename brings it into the canonical tree dir.
        autosave_loc = uuid_tree_path(
            os.path.join(working_dir, AUTOSAVE_DIR_NAME), node_uuid, filename
        )
        if os.path.exists(autosave_loc):
            ensure_parent(canonical)
            try:
                os.replace(autosave_loc, canonical)
                return True
            except OSError as exc:
                # EXDEV (cross-device) is the realistic failure here —
                # rare, since `.autosave/` is a subdir of saveDir, but
                # bind-mounts and overlay filesystems can split them.
                # Fall back to copy+remove so we don't orphan the
                # autosave file on the source side.
                import errno  # noqa: PLC0415
                import shutil  # noqa: PLC0415
                if getattr(exc, "errno", None) == errno.EXDEV:
                    # Cross-device rename failed; stage to a sibling
                    # `.tmp` on the destination volume and atomically
                    # replace. This keeps the canonical path either
                    # fully-old or fully-new even if a crash happens
                    # between the copy and the rename.
                    canonical_tmp = canonical + ".tmp"
                    try:
                        shutil.copy2(autosave_loc, canonical_tmp)
                    except OSError:
                        try:
                            os.remove(canonical_tmp)
                        except OSError:
                            pass
                        return False
                    try:
                        os.replace(canonical_tmp, canonical)
                    except OSError:
                        try:
                            os.remove(canonical_tmp)
                        except OSError:
                            pass
                        return False
                    # Canonical is in place. Best-effort remove of the
                    # autosave source; failure here just leaves an
                    # orphan that the autosave's own
                    # `_purge_orphaned_tree_files` will collect on its
                    # next run.
                    try:
                        os.remove(autosave_loc)
                    except OSError:
                        pass
                    return True
                # Permission or other non-EXDEV failure — re-serialize.
                return False
        return False

    # Autosave save: the canonical file may live in the parent's tree dir
    # from a prior explicit save. The recovery overlay (overlayAutosaveTreeFiles)
    # leaves canonical files in place at load time, and copyFilesForLoad has
    # already brought them into the working dir.
    parent = os.path.dirname(working_norm)
    if parent:
        parent_loc = uuid_tree_path(parent, node_uuid, filename)
        if os.path.exists(parent_loc):
            return True
    return False


def _try_autosave_cache(
    autosave_cache: "dict[str, tuple[bytes, dict]] | None",
    tree_path: str,
    value: Any,
    source_dir: str,
    hit_counter: "list[int] | None",
    working_dir: str,
) -> "tuple[bytes | None, dict | None]":
    """Check autosave cache for an unchanged data node.

    Returns ``(digest, cached_descriptor)`` on cache hit, ``(digest, None)``
    on miss, or ``(None, None)`` when caching is disabled. When provided,
    ``hit_counter[0]`` is incremented on every cache hit.

    A "hit" is only returned when the cached descriptor's backing file is
    reachable from ``working_dir`` — see :func:`_verify_or_relocate_cached_file`.
    If the digest matches but the file has gone missing (e.g. the canonical
    tree dir was wiped between sessions), the cache entry is dropped and the
    caller falls back to re-serializing. This keeps ``tree-index.json`` and
    the on-disk tree consistent even after the cache and the filesystem
    drift apart.
    """
    if autosave_cache is None:
        return None, None
    from pdv.checksum import node_digest  # noqa: PLC0415

    digest = node_digest(value, source_dir)
    cached = autosave_cache.get(tree_path)
    if cached is not None and cached[0] == digest:
        if _verify_or_relocate_cached_file(cached[1], working_dir):
            if hit_counter is not None:
                hit_counter[0] += 1
            return digest, cached[1]
        # File can't be located. Drop the stale entry so the caller's
        # re-serialize repopulates the cache with a fresh descriptor.
        autosave_cache.pop(tree_path, None)
    return digest, None


def serialize_node(
    tree_path: str,
    value: Any,
    working_dir: str,
    *,
    trusted: bool = False,
    source_dir: str = "",
    autosave_cache: "dict[str, tuple[bytes, dict]] | None" = None,
    autosave_hits: "list[int] | None" = None,
) -> dict:
    """Serialize a value to disk and return a node descriptor dict.

    Chooses the appropriate format based on ``detect_kind(value)``,
    writes the data file, and returns a node descriptor matching
    ARCHITECTURE.md §7.3.

    The ``source_dir`` argument is only consulted by file-backed kinds
    (PDVScript, PDVMarkdown, PDVGui, PDVLib, PDVNamelist). For these kinds,
    the source file lives in ``source_dir`` (typically the kernel working
    directory) while serialized output is written to a separate save dir.
    Defaults to ``working_dir`` when omitted.

    Parameters
    ----------
    tree_path : str
        Dot-separated tree path (used to compute the filesystem path and
        as the ``id``/``path`` in the returned descriptor).
    value : Any
        The Python value to serialize.
    working_dir : str
        Absolute path to the output directory. Data files are written
        under ``<working_dir>/tree/``.
    trusted : bool
        If True, allows pickle serialization for unknown types. If False,
        unknown types raise :class:`PDVSerializationError`.
    source_dir : str
        Absolute path to the directory where existing source files
        (scripts, libs, etc.) live. Defaults to ``working_dir`` when
        empty. Needed when source files are in the kernel working dir
        but output is written to a separate save dir.
    autosave_cache : dict or None
        When provided, data nodes (ndarray, DataFrame, etc.) are
        checksum-compared against previous autosave results. Unchanged
        nodes reuse their cached UUID and skip file I/O. The dict is
        mutated in place with ``{tree_path: (digest, descriptor)}``
        entries on every miss.
    autosave_hits : list[int] or None
        Optional one-element counter; ``autosave_hits[0]`` is incremented
        on every cache hit. Lets callers report cache effectiveness in
        autosave logs. Ignored when ``autosave_cache`` is None.

    Returns
    -------
    dict
        Node descriptor dict as defined in ARCHITECTURE.md §7.3,
        including ``id``, ``path``, ``key``, ``type``, ``storage``,
        ``has_children``, ``created_at``, ``updated_at``,
        and a ``metadata`` sub-dict with type-specific fields
        (``shape``, ``dtype``, ``preview``, ``module_id``, etc.).

    Raises
    ------
    PDVSerializationError
        If the value cannot be serialized (e.g. unknown type and
        ``trusted=False``).
    """
    import datetime
    import json
    import os
    import pickle

    from pdv.environment import (  # noqa: PLC0415
        ensure_parent,
        generate_node_uuid,
        smart_copy,
        uuid_tree_path,
    )
    from pdv.tree import PDVFile, PDVScript, PDVLib, PDVGui, PDVNote  # noqa: PLC0415

    # File extension and format for each PDVFile subclass
    _FILE_KIND_MAP: dict[str, tuple[str, str]] = {
        KIND_SCRIPT: (".py", FORMAT_PY_SCRIPT),
        KIND_MARKDOWN: (".md", FORMAT_MARKDOWN),
        KIND_GUI: (".gui.json", FORMAT_GUI_JSON),
        KIND_LIB: (".py", FORMAT_PY_LIB),
    }

    def _file_storage(node_uuid: str, filename: str, fmt: str) -> dict:
        return {
            "backend": "local_file",
            "uuid": node_uuid,
            "filename": filename,
            "format": fmt,
        }

    _source_dir = source_dir or working_dir

    kind = detect_kind(value)
    now = (
        datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    )
    parts = tree_path.split(".")
    key = parts[-1]
    parent_path = ".".join(parts[:-1]) if len(parts) > 1 else ""

    # Base descriptor fields common to all node types (universal top-level)
    preview = node_preview(value, kind)
    descriptor: dict = {
        "id": tree_path,
        "path": tree_path,
        "key": key,
        "parent_path": parent_path,
        "type": kind,
        "python_type": python_type_string(value),
        "has_children": False,
        "created_at": now,
        "updated_at": now,
    }
    # Module-owned file nodes carry the rel-path inside their owning
    # module's root so the save-time sync step can mirror working-dir
    # edits back to <saveDir>/modules/<id>/. See ARCHITECTURE.md §5.13.
    if isinstance(value, PDVFile) and getattr(value, "source_rel_path", None):
        descriptor["source_rel_path"] = value.source_rel_path

    if kind == KIND_FOLDER:
        descriptor["has_children"] = True
        descriptor["storage"] = {"backend": "none", "format": "none"}
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    if kind == KIND_MODULE:
        descriptor["has_children"] = True
        descriptor["storage"] = {
            "backend": "inline",
            "format": FORMAT_MODULE_META,
            "value": {
                "module_id": value.module_id,
                "name": value.name,
                "version": value.version,
            },
        }
        descriptor["metadata"] = {
            "module_id": value.module_id,
            "name": value.name,
            "version": value.version,
            "preview": preview,
        }
        return descriptor

    # -- PDVFile subclasses (PDVScript, PDVNote, future file types) -----------
    if kind in _FILE_KIND_MAP:
        _ext, fmt = _FILE_KIND_MAP[kind]
        source_path = value.resolve_path(_source_dir)  # type: ignore[union-attr]
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"File not found: {source_path}")
        node_uuid = value.uuid  # type: ignore[union-attr]
        node_filename = value.filename  # type: ignore[union-attr]
        dest_path = uuid_tree_path(working_dir, node_uuid, node_filename)
        if os.path.abspath(source_path) != os.path.abspath(dest_path):
            smart_copy(source_path, dest_path)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, node_filename, fmt)
        # Build type-specific metadata
        meta: dict[str, Any] = {"preview": preview}
        if isinstance(value, PDVScript):
            meta["language"] = value.language
            meta["doc"] = value.doc
        elif isinstance(value, PDVLib):
            meta["language"] = "python"
            if value.module_id:
                meta["module_id"] = value.module_id
        elif kind == KIND_GUI:
            if isinstance(value, PDVGui) and value.module_id:
                meta["module_id"] = value.module_id
            meta["language"] = "json"
        elif kind == KIND_MARKDOWN:
            meta["language"] = "markdown"
            if isinstance(value, PDVNote) and value.title:
                meta["title"] = value.title
        descriptor["metadata"] = meta
        return descriptor

    if kind == KIND_NAMELIST:
        source_path = value.resolve_path(_source_dir)
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"File not found: {source_path}")
        node_uuid = value.uuid
        node_filename = value.filename
        dest_path = uuid_tree_path(working_dir, node_uuid, node_filename)
        if os.path.abspath(source_path) != os.path.abspath(dest_path):
            smart_copy(source_path, dest_path)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, node_filename, FORMAT_NAMELIST)
        descriptor["metadata"] = {
            "module_id": value.module_id,
            "namelist_format": value.format,
            "language": "namelist",
            "preview": preview,
        }
        return descriptor

    if kind == KIND_FILE:
        source_path = value.resolve_path(_source_dir)
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"File not found: {source_path}")
        node_uuid = value.uuid
        node_filename = value.filename
        dest_path = uuid_tree_path(working_dir, node_uuid, node_filename)
        if os.path.abspath(source_path) != os.path.abspath(dest_path):
            smart_copy(source_path, dest_path)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, node_filename, FORMAT_FILE)
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    if kind == KIND_NDARRAY:
        _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits, working_dir)
        if _cached is not None:
            return _cached

        import numpy as np  # noqa: PLC0415

        node_uuid = generate_node_uuid()
        filename = key + ".npy"
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        np.save(file_path, value)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_NPY)
        descriptor["metadata"] = {
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "size_bytes": value.nbytes,
            "preview": preview,
        }
        if _digest is not None:
            autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        return descriptor

    if kind in (KIND_DATAFRAME, KIND_SERIES):
        # PDV saves are internal, so pandas DataFrames and Series go through
        # pickle. This avoids an external parquet-engine dependency and keeps
        # name/index/dtype/extension-type round-trips lossless. Users who want
        # parquet for interchange can write it themselves.
        _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits, working_dir)
        if _cached is not None:
            return _cached

        node_uuid = generate_node_uuid()
        filename = key + ".pickle"
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        with open(file_path, "wb") as fh:
            pickle.dump(value, fh)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PICKLE)
        if kind == KIND_DATAFRAME:
            shape = list(value.shape)  # type: ignore[union-attr]
        else:
            shape = [len(value)]  # type: ignore[arg-type]
        descriptor["metadata"] = {
            "shape": shape,
            "preview": preview,
        }
        if _digest is not None:
            autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        return descriptor

    if kind == KIND_SCALAR:
        if isinstance(value, complex) or (
            isinstance(value, float) and not math.isfinite(value)
        ):
            # complex isn't JSON-native, so the inline path can't store it.
            # NaN/inf floats are JSON-native to json.dumps but serialize as
            # bare NaN/Infinity tokens — invalid JSON that the app's
            # JSON.parse rejects, corrupting tree-index.json.
            # Pickle both like other non-JSON-native values.
            node_uuid = generate_node_uuid()
            filename = key + ".pickle"
            file_path = uuid_tree_path(working_dir, node_uuid, filename)
            ensure_parent(file_path)
            with open(file_path, "wb") as fh:
                pickle.dump(value, fh)
            descriptor["uuid"] = node_uuid
            descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PICKLE)
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        descriptor["storage"] = {
            "backend": "inline",
            "format": FORMAT_INLINE,
            "value": value,
        }
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    if kind == KIND_TEXT:
        # Store short strings inline; long strings as .txt files
        if len(value) <= 1000:  # type: ignore[arg-type]
            descriptor["storage"] = {
                "backend": "inline",
                "format": FORMAT_INLINE,
                "value": value,
            }
        else:
            _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits, working_dir)
            if _cached is not None:
                return _cached
            node_uuid = generate_node_uuid()
            filename = key + ".txt"
            file_path = uuid_tree_path(working_dir, node_uuid, filename)
            ensure_parent(file_path)
            with open(file_path, "w", encoding="utf-8") as fh:
                fh.write(value)  # type: ignore[arg-type]
            descriptor["uuid"] = node_uuid
            descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_TXT)
            if _digest is not None:
                autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    if kind == KIND_MAPPING:
        if _can_inline_json(value):
            descriptor["storage"] = {
                "backend": "inline",
                "format": FORMAT_INLINE,
                "value": value,
            }
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        if not _has_array_leaf(value):
            # No ndarray/DataFrame/Series anywhere — pickle the whole dict so
            # nested tuples, sets, complex, bytes, etc. round-trip with type
            # fidelity. (The composite/per-leaf path is reserved for dicts
            # whose array leaves benefit from their own files.)
            node_uuid = generate_node_uuid()
            filename = key + ".pickle"
            file_path = uuid_tree_path(working_dir, node_uuid, filename)
            ensure_parent(file_path)
            with open(file_path, "wb") as fh:
                pickle.dump(value, fh)
            descriptor["uuid"] = node_uuid
            descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PICKLE)
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        # Composite mapping: at least one array leaf. Emit a container
        # descriptor; the save walker (_collect_nodes) recurses and emits
        # per-leaf descriptors so each array reaches its own fast path
        # (.npy, .pickle, etc). Reconstructed on load as a plain dict.
        descriptor["has_children"] = True
        descriptor["storage"] = {"backend": "none", "format": "none"}
        descriptor["metadata"] = {"preview": preview, "composite": True}
        return descriptor

    if kind == KIND_SEQUENCE:
        # Lists of purely JSON-faithful values stay inline (cheap, no file).
        if _can_inline_json(value):
            descriptor["storage"] = {
                "backend": "inline",
                "format": FORMAT_INLINE,
                "value": value,
            }
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        # Anything else — tuples, sets, frozensets, lists of tuples, lists
        # containing complex/bytes — pickles, which preserves type fidelity
        # at every nesting level. Sequences containing ndarray/DataFrame
        # leaves are still rejected: those need to be split into a dict so
        # each array gets its own file for fast random access.
        if not _has_array_leaf(value):
            node_uuid = generate_node_uuid()
            filename = key + ".pickle"
            file_path = uuid_tree_path(working_dir, node_uuid, filename)
            ensure_parent(file_path)
            with open(file_path, "wb") as fh:
                pickle.dump(value, fh)
            descriptor["uuid"] = node_uuid
            descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PICKLE)
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        raise PDVSerializationError(
            f"Sequence at '{tree_path}' contains array leaves (ndarray, "
            f"DataFrame, Series). PDV does not yet support composite "
            f"sequences — wrap the values in a dict with named keys, "
            f"e.g. {{'0': arr0, '1': arr1}}, so each element can be "
            f"stored in its own file."
        )

    if kind == KIND_BINARY:
        _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits, working_dir)
        if _cached is not None:
            return _cached
        node_uuid = generate_node_uuid()
        filename = key + ".bin"
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        with open(file_path, "wb") as fh:
            fh.write(value)  # type: ignore[arg-type]
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, "bin")
        descriptor["metadata"] = {"preview": preview}
        if _digest is not None:
            autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        return descriptor

    # KIND_UNKNOWN — try a registered custom serializer before falling back to pickle.
    _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits, working_dir)
    if _cached is not None:
        return _cached

    # xarray DataArrays and Datasets pickle as a builtin, overriding any
    # user-registered custom serializer until first-class xarray support
    # lands in beta. This keeps round-trips reliable without requiring
    # users to import a registration module before loading a project.
    if _is_xarray_object(value):
        node_uuid = generate_node_uuid()
        filename = key + ".pickle"
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        with open(file_path, "wb") as fh:
            pickle.dump(value, fh)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PICKLE)
        descriptor["metadata"] = {
            "preview": preview,
            "python_type": python_type_string(value),
        }
        if _digest is not None:
            autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        return descriptor

    from pdv import serializers as _serializers  # noqa: PLC0415

    custom = _serializers.find_for_value(value)
    if custom is not None:
        node_uuid = generate_node_uuid()
        filename = key + custom.extension
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        try:
            custom.save(value, file_path)
        except Exception as exc:  # noqa: BLE001
            raise PDVSerializationError(
                f"Custom serializer '{custom.class_name}' failed to save "
                f"value at '{tree_path}': {exc}"
            ) from exc
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, custom.format)
        descriptor["metadata"] = {
            "preview": preview,
            "python_type": python_type_string(value),
            "serializer": custom.class_name,
        }
        if _digest is not None:
            autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        return descriptor

    dunder = _serializers.find_for_value_dunder(value)
    if dunder is not None:
        node_uuid = generate_node_uuid()
        filename = key + dunder.extension
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        try:
            value.__pdv_serialize__(file_path)
        except Exception as exc:  # noqa: BLE001
            raise PDVSerializationError(
                f"Dunder serializer for '{dunder.class_name}' failed to save "
                f"value at '{tree_path}': {exc}"
            ) from exc
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, dunder.format)
        descriptor["metadata"] = {
            "preview": preview,
            "python_type": python_type_string(value),
            "serializer": f"dunder:{dunder.class_name}",
        }
        if _digest is not None:
            autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
        return descriptor

    if not trusted:
        raise PDVSerializationError(
            f"Cannot serialize value of type '{type(value).__name__}' at path "
            f"'{tree_path}'. Register a custom serializer with "
            f"pdv.register_serializer(), or pass trusted=True to allow pickle."
        )
    node_uuid = generate_node_uuid()
    filename = key + ".pickle"
    file_path = uuid_tree_path(working_dir, node_uuid, filename)
    ensure_parent(file_path)
    with open(file_path, "wb") as fh:
        pickle.dump(value, fh)
    descriptor["uuid"] = node_uuid
    descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PICKLE)
    descriptor["metadata"] = {"preview": preview}
    if _digest is not None:
        autosave_cache[tree_path] = (_digest, descriptor)  # type: ignore[index]
    return descriptor


def pickle_fallback_node(tree_path: str, value: Any, working_dir: str) -> dict:
    """Unconditionally write ``value`` as a pickle file and return a descriptor.

    Super-fallback used by the save walker (:func:`_collect_nodes` in
    ``handlers.project``) when :func:`serialize_node` raises
    :class:`PDVSerializationError` for any reason. The policy is: the user's
    data integrity trumps format purity — ``project.save`` must never fail
    because of a single weird tree value.

    Unlike the ``trusted=True`` branch of :func:`serialize_node`, this helper
    bypasses the trusted gate entirely: the pickle file is written by this
    same process and read back by this same process on project load (which
    always passes ``trusted=True``), so there is no untrusted-code surface.

    The returned descriptor carries ``metadata.fallback == "pickle"`` so that
    tests, logs, and any future UI affordance can distinguish fallback nodes
    from nodes whose value naturally required pickle.

    Parameters
    ----------
    tree_path : str
        Dot-separated tree path for the node.
    value : Any
        The value to pickle. May be anything picklable; if pickle itself
        fails, the underlying exception propagates (at which point the save
        truly cannot proceed).
    working_dir : str
        Absolute path to the save directory. The pickle file is written
        under ``<working_dir>/tree/``.

    Returns
    -------
    dict
        A node descriptor with ``storage.backend == "local_file"``,
        ``storage.format == FORMAT_PICKLE``, and
        ``metadata.fallback == "pickle"``.
    """
    import datetime
    import os
    import pickle

    from pdv.environment import (  # noqa: PLC0415
        ensure_parent,
        generate_node_uuid,
        uuid_tree_path,
    )

    node_uuid = generate_node_uuid()
    parts = tree_path.split(".")
    key = parts[-1]
    filename = key + ".pickle"
    file_path = uuid_tree_path(working_dir, node_uuid, filename)
    ensure_parent(file_path)
    with open(file_path, "wb") as fh:
        pickle.dump(value, fh)

    now = (
        datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    )
    parent_path = ".".join(parts[:-1]) if len(parts) > 1 else ""

    return {
        "id": tree_path,
        "path": tree_path,
        "key": key,
        "parent_path": parent_path,
        "type": KIND_UNKNOWN,
        "python_type": python_type_string(value),
        "uuid": node_uuid,
        "has_children": False,
        "created_at": now,
        "updated_at": now,
        "storage": {
            "backend": "local_file",
            "uuid": node_uuid,
            "filename": filename,
            "format": FORMAT_PICKLE,
        },
        "metadata": {
            "preview": node_preview(value, KIND_UNKNOWN),
            "python_type": python_type_string(value),
            "fallback": "pickle",
        },
    }


def deserialize_node(
    storage_ref: dict,
    save_dir: str,
    *,
    trusted: bool = False,
    python_type: str = "",
) -> Any:
    """Deserialize a value from disk given a storage reference dict.

    Parameters
    ----------
    storage_ref : dict
        Storage reference dict as defined in ARCHITECTURE.md §7.3.
        Must contain ``backend``, and for ``local_file`` backend:
        ``uuid``, ``filename``, and ``format``.
    save_dir : str
        Absolute path to the project save directory (or working directory
        for session-local files).
    trusted : bool
        If True, allows pickle deserialization. If False, pickle files
        raise :class:`PDVSerializationError`. Production project-load and
        module-import handlers always pass ``trusted=True`` (the on-disk
        pickle was written by this same process). The ``trusted=False``
        path exists for tests and any future user-facing import flow that
        wants to surface untrusted pickles as errors instead of executing
        them.
    python_type : str
        Dotted ``"module.qualname"`` recovered from the descriptor's
        ``metadata.python_type``. When non-empty and the format is not one
        of the builtins or registered serializers, PDV uses this string to
        import the class and call its ``__pdv_deserialize__`` classmethod
        (the dunder protocol). When empty (legacy descriptors written
        before the dunder protocol existed), the lookup is skipped and the
        existing "Unsupported storage format" error fires.

    Returns
    -------
    Any
        The deserialized Python value.

    Raises
    ------
    PDVSerializationError
        If the file cannot be read, the format is unsupported, or
        pickle is required but ``trusted=False``.
    FileNotFoundError
        If the backing file does not exist.
    """
    import json
    import os
    import pickle

    from pdv.environment import uuid_tree_path  # noqa: PLC0415

    backend = storage_ref.get("backend", "")

    if backend == "none":
        # Folder node: no backing file
        return {}

    if backend == "inline":
        return storage_ref["value"]

    if backend == "local_file":
        fmt = storage_ref.get("format", "")
        node_uuid = storage_ref.get("uuid", "")
        filename = storage_ref.get("filename", "")
        abs_path = uuid_tree_path(save_dir, node_uuid, filename)

        if not os.path.exists(abs_path):
            raise FileNotFoundError(f"Backing file not found: {abs_path}")

        if fmt == FORMAT_NPY:
            import numpy as np  # noqa: PLC0415

            return np.load(abs_path, allow_pickle=False)

        if fmt == FORMAT_TXT:
            with open(abs_path, "r", encoding="utf-8") as fh:
                return fh.read()

        if fmt == FORMAT_MARKDOWN:
            with open(abs_path, "r", encoding="utf-8") as fh:
                return fh.read()

        if fmt == FORMAT_JSON:
            with open(abs_path, "r", encoding="utf-8") as fh:
                return json.load(fh)

        if fmt == FORMAT_GUI_JSON:
            with open(abs_path, "r", encoding="utf-8") as fh:
                return json.load(fh)

        if fmt == "bin":
            with open(abs_path, "rb") as fh:
                return fh.read()

        if fmt == FORMAT_FILE:
            with open(abs_path, "rb") as fh:
                return fh.read()

        if fmt == FORMAT_PICKLE:
            if not trusted:
                raise PDVSerializationError(
                    "Pickle deserialization is disabled. Pass trusted=True to allow it."
                )
            with open(abs_path, "rb") as fh:
                return pickle.load(fh)  # noqa: S301

        from pdv import serializers as _serializers  # noqa: PLC0415

        custom = _serializers.find_for_format(fmt)
        if custom is not None:
            try:
                return custom.load(abs_path)
            except Exception as exc:  # noqa: BLE001
                raise PDVSerializationError(
                    f"Custom serializer '{custom.class_name}' failed to load "
                    f"'{abs_path}': {exc}"
                ) from exc

        if python_type:
            cls, reason = _serializers.find_for_format_dunder(fmt, python_type)
            if cls is not None:
                try:
                    return cls.__pdv_deserialize__(abs_path)
                except Exception as exc:  # noqa: BLE001
                    raise PDVSerializationError(
                        f"Dunder deserializer "
                        f"'{python_type}.__pdv_deserialize__' failed to load "
                        f"'{abs_path}': {exc}"
                    ) from exc
            if reason == _serializers.LOOKUP_IMPORT_FAILED:
                raise PDVSerializationError(
                    f"Unsupported storage format: '{fmt}'. PDV tried to import "
                    f"'{python_type}' to recover its __pdv_deserialize__ "
                    f"classmethod, but no prefix of that path could be "
                    f"imported. Ensure the defining package is installed in "
                    f"the kernel's Python environment, or import a module "
                    f"that registers a serializer for this format before "
                    f"loading the project."
                )
            # reason == LOOKUP_CLASS_UNLOADABLE: module imported but the class
            # is missing, was renamed, or no longer implements the protocol.
            raise PDVSerializationError(
                f"Unsupported storage format: '{fmt}'. PDV found '{python_type}' "
                f"reachable from the kernel's Python environment, but it is "
                f"not a class that implements __pdv_deserialize__ — the class "
                f"was likely renamed, removed, or upgraded to a version that "
                f"dropped the dunder protocol. Pin the older version of the "
                f"defining package, or import a module that registers a "
                f"serializer for this format before loading the project."
            )

        raise PDVSerializationError(
            f"Unsupported storage format: '{fmt}'. If this format was written "
            f"by a custom serializer, import the module that registered it "
            f"before loading the project."
        )

    raise PDVSerializationError(f"Unsupported storage backend: '{backend}'")


def node_preview(value: Any, kind: str) -> str:
    """Generate a short human-readable preview string for the tree panel.

    Parameters
    ----------
    value : Any
        The Python value.
    kind : str
        Kind string from :func:`detect_kind`.

    Returns
    -------
    str
        A short preview string (≤100 characters).
    """
    try:
        if kind == KIND_FOLDER:
            # "folder" was misleading because PDV folders are PDVTree
            # subnodes, not filesystem folders. The chip shows `tree`;
            # the preview matches and adds the child count.
            return f"tree ({len(value)} items)"
        if kind in (KIND_MODULE, KIND_GUI, KIND_NAMELIST, KIND_LIB):
            return value.preview() if hasattr(value, "preview") else kind
        if kind in (KIND_SCRIPT, KIND_MARKDOWN):
            return value.preview() if hasattr(value, "preview") else kind
        if kind == KIND_FILE:
            return value.preview() if hasattr(value, "preview") else "file"
        if kind == KIND_SCALAR:
            return str(value)[:100]
        if kind == KIND_TEXT:
            text = str(value)
            if len(text) <= 50:
                return text
            return text[:50] + "..."
        if kind == KIND_BINARY:
            return f"bytes ({len(value)} bytes)"
        if kind == KIND_MAPPING:
            return f"dict ({len(value)} keys)"
        if kind == KIND_SEQUENCE:
            if isinstance(value, frozenset):
                noun = "frozenset"
            elif isinstance(value, set):
                noun = "set"
            elif isinstance(value, tuple):
                noun = "tuple"
            else:
                noun = "list"
            return f"{noun} ({len(value)} items)"
        if kind == KIND_NDARRAY:

            shape_str = " × ".join(str(d) for d in value.shape)
            return f"{value.dtype} array ({shape_str})"
        if kind == KIND_DATAFRAME:
            rows, cols = value.shape
            return f"DataFrame ({rows} × {cols})"
        if kind == KIND_SERIES:
            return f"Series ({len(value)},)"
        if kind == KIND_DATASET:
            return f"{len(value.data_vars)} vars"
        if kind == KIND_DATAARRAY:
            if not value.dims:
                return "scalar"
            return ", ".join(f"{d}: {s}" for d, s in zip(value.dims, value.shape))
    except Exception:  # noqa: BLE001
        pass
    # Prefer a registered serializer's preview callback for unknown types.
    try:
        from pdv import serializers as _serializers  # noqa: PLC0415

        entry = _serializers.find_for_value(value)
        if entry is not None and entry.preview is not None:
            return str(entry.preview(value))[:100]
    except Exception:  # noqa: BLE001
        pass
    # Dunder-protocol classes can supply __pdv_preview__ directly on the class.
    if hasattr(type(value), "__pdv_preview__"):
        try:
            return str(value.__pdv_preview__())[:100]
        except Exception:  # noqa: BLE001
            pass
    # Custom types may provide a preview() method (e.g. module-defined types
    # with registered handlers).
    if hasattr(value, "preview") and callable(value.preview):
        try:
            return str(value.preview())[:100]
        except Exception:  # noqa: BLE001
            pass
    return "<unknown type>"
