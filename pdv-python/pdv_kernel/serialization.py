"""
pdv_kernel.serialization — Type detection and format readers/writers.

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

from pdv_kernel.errors import PDVSerializationError


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
    raise ImportError(
        "No parquet engine available. Install pyarrow or fastparquet."
    )


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
    from pdv_kernel.tree import PDVTree, PDVScript, PDVNote, PDVFile, PDVModule, PDVGui, PDVNamelist, PDVLib  # noqa: PLC0415

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


def serialize_node(
    tree_path: str,
    value: Any,
    working_dir: str,
    *,
    trusted: bool = False,
    source_dir: str = "",
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
    import shutil

    from pdv_kernel.environment import ensure_parent, working_dir_tree_path  # noqa: PLC0415
    from pdv_kernel.tree import PDVFile, PDVScript, PDVModule, PDVLib, PDVGui, PDVNote  # noqa: PLC0415

    # File extension and format for each PDVFile subclass
    _FILE_KIND_MAP: dict[str, tuple[str, str]] = {
        KIND_SCRIPT:   (".py", FORMAT_PY_SCRIPT),
        KIND_MARKDOWN: (".md", FORMAT_MARKDOWN),
        KIND_GUI:      (".gui.json", FORMAT_GUI_JSON),
        KIND_LIB:      (".py", FORMAT_PY_LIB),
    }

    _source_dir = source_dir or working_dir

    kind = detect_kind(value)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
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
        ext, fmt = _FILE_KIND_MAP[kind]
        source_path = value.resolve_path(_source_dir)  # type: ignore[union-attr]
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"File not found: {source_path}")
        if isinstance(value, PDVLib):
            # Lib files keep their original filename so that the Python import
            # name stays consistent (e.g. n_pendulum.py → import n_pendulum).
            # working_dir_tree_path would derive the name from the tree key,
            # which has been mangled (n_pendulum_py).
            if os.path.isabs(value.relative_path):
                rel_path = os.path.relpath(source_path, _source_dir)
            else:
                rel_path = value.relative_path
            # Copy lib file to save dir so it persists with the project
            dest_path = os.path.join(working_dir, rel_path)
            if os.path.abspath(source_path) != os.path.abspath(dest_path):
                ensure_parent(dest_path)
                shutil.copy2(source_path, dest_path)
        else:
            file_path = working_dir_tree_path(working_dir, tree_path, ext)
            ensure_parent(file_path)
            if os.path.abspath(source_path) != os.path.abspath(file_path):
                shutil.copy2(source_path, file_path)
            rel_path = os.path.relpath(file_path, working_dir)
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": fmt,
        }
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
        ext = os.path.splitext(value.relative_path)[1] or ".nml"
        source_path = value.resolve_path(_source_dir)
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"File not found: {source_path}")
        file_path = working_dir_tree_path(working_dir, tree_path, ext)
        ensure_parent(file_path)
        if os.path.abspath(source_path) != os.path.abspath(file_path):
            shutil.copy2(source_path, file_path)
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_NAMELIST,
        }
        descriptor["metadata"] = {
            "module_id": value.module_id,
            "namelist_format": value.format,
            "language": "namelist",
            "preview": preview,
        }
        return descriptor

    if kind == KIND_NDARRAY:
        import numpy as np  # noqa: PLC0415

        file_path = working_dir_tree_path(working_dir, tree_path, ".npy")
        ensure_parent(file_path)
        np.save(file_path, value)
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_NPY,
        }
        descriptor["metadata"] = {
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "size_bytes": value.nbytes,
            "preview": preview,
        }
        return descriptor

    if kind in (KIND_DATAFRAME, KIND_SERIES):
        file_path = working_dir_tree_path(working_dir, tree_path, ".parquet")
        ensure_parent(file_path)
        _write_parquet(value, file_path)
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_PARQUET,
        }
        if kind == KIND_DATAFRAME:
            shape = list(value.shape)  # type: ignore[union-attr]
        else:
            shape = [len(value)]  # type: ignore[arg-type]
        descriptor["metadata"] = {
            "shape": shape,
            "preview": preview,
        }
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
            file_path = working_dir_tree_path(working_dir, tree_path, ".txt")
            ensure_parent(file_path)
            with open(file_path, "w", encoding="utf-8") as fh:
                fh.write(value)  # type: ignore[arg-type]
            rel_path = os.path.relpath(file_path, working_dir)
            descriptor["storage"] = {
                "backend": "local_file",
                "relative_path": rel_path,
                "format": FORMAT_TXT,
            }
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    if kind in (KIND_MAPPING, KIND_SEQUENCE):
        try:
            json.dumps(value)
        except (TypeError, ValueError) as exc:
            raise PDVSerializationError(
                f"Value at '{tree_path}' is not JSON-serializable: {exc}"
            ) from exc
        descriptor["storage"] = {
            "backend": "inline",
            "format": FORMAT_INLINE,
            "value": value,
        }
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    if kind == KIND_BINARY:
        file_path = working_dir_tree_path(working_dir, tree_path, ".bin")
        ensure_parent(file_path)
        with open(file_path, "wb") as fh:
            fh.write(value)  # type: ignore[arg-type]
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": "bin",
        }
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    # KIND_UNKNOWN — try a registered custom serializer before falling back to pickle.
    from pdv_kernel import serializers as _serializers  # noqa: PLC0415

    custom = _serializers.find_for_value(value)
    if custom is not None:
        file_path = working_dir_tree_path(working_dir, tree_path, custom.extension)
        ensure_parent(file_path)
        try:
            custom.save(value, file_path)
        except Exception as exc:  # noqa: BLE001
            raise PDVSerializationError(
                f"Custom serializer '{custom.class_name}' failed to save "
                f"value at '{tree_path}': {exc}"
            ) from exc
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": custom.format,
        }
        descriptor["metadata"] = {
            "preview": preview,
            "python_type": python_type_string(value),
            "serializer": custom.class_name,
        }
        return descriptor

    if not trusted:
        raise PDVSerializationError(
            f"Cannot serialize value of type '{type(value).__name__}' at path "
            f"'{tree_path}'. Register a custom serializer with "
            f"pdv.register_serializer(), or pass trusted=True to allow pickle."
        )
    file_path = working_dir_tree_path(working_dir, tree_path, ".pickle")
    ensure_parent(file_path)
    with open(file_path, "wb") as fh:
        pickle.dump(value, fh)
    rel_path = os.path.relpath(file_path, working_dir)
    descriptor["storage"] = {
        "backend": "local_file",
        "relative_path": rel_path,
        "format": FORMAT_PICKLE,
    }
    descriptor["metadata"] = {"preview": preview}
    return descriptor


def deserialize_node(storage_ref: dict, save_dir: str, *, trusted: bool = False) -> Any:
    """Deserialize a value from disk given a storage reference dict.

    Parameters
    ----------
    storage_ref : dict
        Storage reference dict as defined in ARCHITECTURE.md §7.3.
        Must contain ``backend``, ``relative_path``, and ``format``.
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

    backend = storage_ref.get("backend", "")

    if backend == "none":
        # Folder node: no backing file
        return {}

    if backend == "inline":
        return storage_ref["value"]

    if backend == "local_file":
        fmt = storage_ref.get("format", "")
        rel_path = storage_ref.get("relative_path", "")
        abs_path = os.path.join(save_dir, rel_path)

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

        if fmt == FORMAT_PICKLE:
            if not trusted:
                raise PDVSerializationError(
                    "Pickle deserialization is disabled. Pass trusted=True to allow it."
                )
            with open(abs_path, "rb") as fh:
                return pickle.load(fh)  # noqa: S301

        from pdv_kernel import serializers as _serializers  # noqa: PLC0415

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
            import numpy as np  # noqa: PLC0415

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
        from pdv_kernel import serializers as _serializers  # noqa: PLC0415

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


