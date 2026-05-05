"""
pdv.serialization — Type detection and format readers/writers.

Handles all conversion between in-memory Python values and on-disk
file representations.

Supported formats
-----------------
- **npy** — NumPy arrays (requires numpy)
- **parquet** — Pandas DataFrame and Series (requires pandas + pyarrow or fastparquet)
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
KIND_UNKNOWN = "unknown"

# Format strings — must match ARCHITECTURE.md §7.3 storage.format
FORMAT_NPY = "npy"
FORMAT_PARQUET = "parquet"
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


def _parquet_engine() -> str:
    """Return the best available parquet engine name.

    Prefers ``'pyarrow'`` when importable, falls back to ``'fastparquet'``.
    Raises :class:`ImportError` if neither is available.
    """
    try:
        import pyarrow  # noqa: F401, PLC0415

        return "pyarrow"
    except ImportError:
        pass
    try:
        import fastparquet  # noqa: F401, PLC0415

        return "fastparquet"
    except ImportError:
        pass
    raise ImportError("No parquet engine available. Install pyarrow or fastparquet.")


def _write_parquet(value: Any, path: str) -> None:
    """Write a DataFrame or Series to a parquet file.

    Uses an explicit engine to avoid pyarrow extension-type registration
    conflicts that occur when ``to_parquet()`` is called without one.
    """
    engine = _parquet_engine()
    try:
        value.to_parquet(path, engine=engine)
    except Exception as primary_err:
        # pyarrow can raise extension-type conflicts on repeated writes
        # in the same process.  Fall back to the other engine if possible.
        fallback = "fastparquet" if engine == "pyarrow" else "pyarrow"
        try:
            value.to_parquet(path, engine=fallback)
        except ImportError:
            raise primary_err from primary_err


def _read_parquet(path: str) -> Any:
    """Read a parquet file into a DataFrame.

    Uses an explicit engine to avoid pyarrow extension-type registration
    conflicts.
    """
    import pandas as pd  # noqa: PLC0415

    engine = _parquet_engine()
    try:
        return pd.read_parquet(path, engine=engine)
    except Exception as primary_err:
        fallback = "fastparquet" if engine == "pyarrow" else "pyarrow"
        try:
            return pd.read_parquet(path, engine=fallback)
        except ImportError:
            raise primary_err from primary_err


def _is_json_native(value: Any) -> bool:
    """Return True if ``value`` can be round-tripped through ``json.dumps``.

    Used by :func:`serialize_node` to decide between the fast inline path for
    plain dicts/lists of JSON-native values and the composite path that
    emits per-leaf descriptors (for dicts containing ndarrays, DataFrames,
    bytes, etc.).
    """
    import json  # noqa: PLC0415

    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True


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
    if isinstance(value, (int, float)) or value is None:
        return KIND_SCALAR
    if isinstance(value, str):
        return KIND_TEXT
    if isinstance(value, (bytes, bytearray)):
        return KIND_BINARY
    if isinstance(value, dict):
        return KIND_MAPPING
    if isinstance(value, (list, tuple)):
        return KIND_SEQUENCE
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


def _try_autosave_cache(
    autosave_cache: "dict[str, tuple[bytes, dict]] | None",
    tree_path: str,
    value: Any,
    source_dir: str,
    hit_counter: "list[int] | None" = None,
) -> "tuple[bytes | None, dict | None]":
    """Check autosave cache for an unchanged data node.

    Returns ``(digest, cached_descriptor)`` on cache hit, ``(digest, None)``
    on miss, or ``(None, None)`` when caching is disabled. When provided,
    ``hit_counter[0]`` is incremented on every cache hit.
    """
    if autosave_cache is None:
        return None, None
    from pdv.checksum import node_digest  # noqa: PLC0415

    digest = node_digest(value, source_dir)
    cached = autosave_cache.get(tree_path)
    if cached is not None and cached[0] == digest:
        if hit_counter is not None:
            hit_counter[0] += 1
        return digest, cached[1]
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
        nodes reuse their cached UUID and skip file I/O.

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
        _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits)
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
        _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits)
        if _cached is not None:
            return _cached

        node_uuid = generate_node_uuid()
        filename = key + ".parquet"
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)
        _write_parquet(value, file_path)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_PARQUET)
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
            _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits)
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
        if _is_json_native(value):
            descriptor["storage"] = {
                "backend": "inline",
                "format": FORMAT_INLINE,
                "value": value,
            }
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        # Composite mapping: one or more leaves are not JSON-serializable.
        # Emit a container descriptor; the save walker (_collect_nodes) is
        # responsible for recursing into the dict and emitting per-leaf
        # descriptors so each leaf reaches its own fast path (.npy, parquet,
        # etc). Reconstructed on load as a plain dict, not a PDVTree.
        descriptor["has_children"] = True
        descriptor["storage"] = {"backend": "none", "format": "none"}
        descriptor["metadata"] = {"preview": preview, "composite": True}
        return descriptor

    if kind == KIND_SEQUENCE:
        if _is_json_native(value):
            descriptor["storage"] = {
                "backend": "inline",
                "format": FORMAT_INLINE,
                "value": value,
            }
            descriptor["metadata"] = {"preview": preview}
            return descriptor
        raise PDVSerializationError(
            f"Sequence at '{tree_path}' contains values that are not "
            f"JSON-serializable (e.g. ndarray, DataFrame). PDV does not yet "
            f"support composite sequences — wrap the values in a dict with "
            f"named keys, e.g. {{'0': arr0, '1': arr1}}, so each element "
            f"can be stored in its own file."
        )

    if kind == KIND_BINARY:
        _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits)
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
    _digest, _cached = _try_autosave_cache(autosave_cache, tree_path, value, _source_dir, autosave_hits)
    if _cached is not None:
        return _cached

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


def deserialize_node(storage_ref: dict, save_dir: str, *, trusted: bool = False) -> Any:
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

        if fmt == FORMAT_PARQUET:
            return _read_parquet(abs_path)

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
            return "folder"
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
            noun = "tuple" if isinstance(value, tuple) else "list"
            return f"{noun} ({len(value)} items)"
        if kind == KIND_NDARRAY:

            shape_str = " × ".join(str(d) for d in value.shape)
            return f"{value.dtype} array ({shape_str})"
        if kind == KIND_DATAFRAME:
            rows, cols = value.shape
            return f"DataFrame ({rows} × {cols})"
        if kind == KIND_SERIES:
            return f"Series ({len(value)},)"
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
    # Custom types may provide a preview() method (e.g. module-defined types
    # with registered handlers).
    if hasattr(value, "preview") and callable(value.preview):
        try:
            return str(value.preview())[:100]
        except Exception:  # noqa: BLE001
            pass
    return "<unknown type>"
