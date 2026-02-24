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
KIND_BINARY = "binary"
KIND_UNKNOWN = "unknown"

# Format strings — must match ARCHITECTURE.md §7.3 storage.format
FORMAT_NPY = "npy"
FORMAT_PARQUET = "parquet"
FORMAT_JSON = "json"
FORMAT_TXT = "txt"
FORMAT_PICKLE = "pickle"
FORMAT_PY_SCRIPT = "py_script"
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
    # TODO: implement in Step 1
    raise NotImplementedError


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
    # TODO: implement in Step 1
    raise NotImplementedError


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
    # TODO: implement in Step 1
    raise NotImplementedError


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
    # TODO: implement in Step 1
    raise NotImplementedError


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
    # TODO: implement in Step 1
    raise NotImplementedError
