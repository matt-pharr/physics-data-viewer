"""
pdv_kernel.serialization — Type detection and format readers/writers.

Handles all conversion between in-memory Python values and on-disk
file representations.

Supported formats
-----------------
- **npy** — NumPy arrays (requires numpy)
- **parquet** — Pandas DataFrame and Series (requires pandas + pyarrow)
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
    from pdv_kernel.tree import PDVTree, PDVScript, PDVNote  # noqa: PLC0415

    if isinstance(value, PDVTree):
        return KIND_FOLDER
    if isinstance(value, PDVScript):
        return KIND_SCRIPT
    if isinstance(value, PDVNote):
        return KIND_MARKDOWN
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
) -> dict:
    """Serialize a value to disk and return a node descriptor dict.

    Chooses the appropriate format based on ``detect_kind(value)``,
    writes the data file, and returns a node descriptor matching
    ARCHITECTURE.md §7.3.

    Parameters
    ----------
    tree_path : str
        Dot-separated tree path (used to compute the filesystem path and
        as the ``id``/``path`` in the returned descriptor).
    value : Any
        The Python value to serialize.
    working_dir : str
        Absolute path to the working directory. Data files are written
        under ``<working_dir>/tree/``.
    trusted : bool
        If True, allows pickle serialization for unknown types. If False,
        unknown types raise :class:`PDVSerializationError`.

    Returns
    -------
    dict
        Node descriptor dict as defined in ARCHITECTURE.md §7.3,
        including ``id``, ``path``, ``key``, ``type``, ``storage``,
        ``has_children``, ``lazy``, ``created_at``, ``updated_at``,
        and type-specific metadata (``shape``, ``dtype``, ``preview``, etc.).

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

    kind = detect_kind(value)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    parts = tree_path.split(".")
    key = parts[-1]
    parent_path = ".".join(parts[:-1]) if len(parts) > 1 else ""

    # Base descriptor fields common to all node types
    descriptor: dict = {
        "id": tree_path,
        "path": tree_path,
        "key": key,
        "parent_path": parent_path,
        "type": kind,
        "has_children": False,
        "lazy": False,
        "created_at": now,
        "updated_at": now,
        "preview": node_preview(value, kind),
        "language": None,
        "actions": [],
    }

    if kind == KIND_FOLDER:
        descriptor["has_children"] = True
        descriptor["storage"] = {"backend": "none", "format": "none"}
        return descriptor

    if kind == KIND_SCRIPT:
        source_path = value.relative_path  # type: ignore[union-attr]
        if not os.path.isabs(source_path):
            source_path = os.path.join(working_dir, source_path)
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"Script file not found: {source_path}")
        file_path = working_dir_tree_path(working_dir, tree_path, ".py")
        ensure_parent(file_path)
        if os.path.abspath(source_path) != os.path.abspath(file_path):
            shutil.copy2(source_path, file_path)
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["language"] = value.language  # type: ignore[union-attr]
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_PY_SCRIPT,
        }
        return descriptor

    if kind == KIND_MARKDOWN:
        source_path = value.relative_path  # type: ignore[union-attr]
        if not os.path.isabs(source_path):
            source_path = os.path.join(working_dir, source_path)
        if not os.path.exists(source_path):
            raise PDVSerializationError(f"Markdown file not found: {source_path}")
        file_path = working_dir_tree_path(working_dir, tree_path, ".md")
        ensure_parent(file_path)
        if os.path.abspath(source_path) != os.path.abspath(file_path):
            shutil.copy2(source_path, file_path)
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["language"] = "markdown"
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_MARKDOWN,
        }
        return descriptor

    if kind == KIND_NDARRAY:
        import numpy as np  # noqa: PLC0415

        file_path = working_dir_tree_path(working_dir, tree_path, ".npy")
        ensure_parent(file_path)
        np.save(file_path, value)
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["lazy"] = True
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_NPY,
        }
        descriptor["shape"] = list(value.shape)
        descriptor["dtype"] = str(value.dtype)
        descriptor["size_bytes"] = value.nbytes
        return descriptor

    if kind in (KIND_DATAFRAME, KIND_SERIES):
        file_path = working_dir_tree_path(working_dir, tree_path, ".parquet")
        ensure_parent(file_path)
        value.to_parquet(file_path)  # type: ignore[union-attr]
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["lazy"] = True
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": FORMAT_PARQUET,
        }
        if kind == KIND_DATAFRAME:
            descriptor["shape"] = list(value.shape)  # type: ignore[union-attr]
        else:
            descriptor["shape"] = [len(value)]  # type: ignore[arg-type]
        return descriptor

    if kind == KIND_SCALAR:
        descriptor["storage"] = {
            "backend": "inline",
            "format": FORMAT_INLINE,
            "value": value,
        }
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
            descriptor["lazy"] = True
            descriptor["storage"] = {
                "backend": "local_file",
                "relative_path": rel_path,
                "format": FORMAT_TXT,
            }
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
        return descriptor

    if kind == KIND_BINARY:
        file_path = working_dir_tree_path(working_dir, tree_path, ".bin")
        ensure_parent(file_path)
        with open(file_path, "wb") as fh:
            fh.write(value)  # type: ignore[arg-type]
        rel_path = os.path.relpath(file_path, working_dir)
        descriptor["lazy"] = True
        descriptor["storage"] = {
            "backend": "local_file",
            "relative_path": rel_path,
            "format": "bin",
        }
        return descriptor

    # KIND_UNKNOWN
    if not trusted:
        raise PDVSerializationError(
            f"Cannot serialize value of type '{type(value).__name__}' at path "
            f"'{tree_path}'. Pass trusted=True to allow pickle serialization."
        )
    file_path = working_dir_tree_path(working_dir, tree_path, ".pickle")
    ensure_parent(file_path)
    with open(file_path, "wb") as fh:
        pickle.dump(value, fh)
    rel_path = os.path.relpath(file_path, working_dir)
    descriptor["lazy"] = True
    descriptor["storage"] = {
        "backend": "local_file",
        "relative_path": rel_path,
        "format": FORMAT_PICKLE,
    }
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
        raise :class:`PDVSerializationError`.

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
            import pandas as pd  # noqa: PLC0415

            return pd.read_parquet(abs_path)

        if fmt == FORMAT_TXT:
            with open(abs_path, "r", encoding="utf-8") as fh:
                return fh.read()

        if fmt == FORMAT_MARKDOWN:
            with open(abs_path, "r", encoding="utf-8") as fh:
                return fh.read()

        if fmt == FORMAT_JSON:
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

        raise PDVSerializationError(f"Unsupported storage format: '{fmt}'")

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
        if kind == KIND_SCRIPT:
            return value.preview() if hasattr(value, "preview") else "PDV script"
        if kind == KIND_MARKDOWN:
            return value.preview() if hasattr(value, "preview") else "Markdown note"
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
    return "<unknown type>"


def extract_docstring_preview(file_path: str) -> str | None:
    """Extract the first line of a Python file's module docstring.

    Parameters
    ----------
    file_path : str
        Absolute path to a Python script file.

    Returns
    -------
    str or None
        First line of the module docstring, or None if absent or unreadable.
    """
    import ast

    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            source = fh.read()
        tree = ast.parse(source)
        doc = ast.get_docstring(tree)
        if doc:
            return doc.strip().splitlines()[0].strip()
    except Exception:  # noqa: BLE001
        pass
    return None
