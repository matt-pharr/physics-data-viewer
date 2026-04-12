"""
pdv_kernel.serializers — Custom serializer registry for module-defined types.

Module developers register a save/load callback pair for a class so that
PDV can persist instances of that class without falling back to ``pickle``.
This is the only supported way to save objects whose state lives outside
Python (ctypes pointers, Fortran library handles, GPU buffers, ...).

Public API
----------
register : function
    ``pdv.register_serializer(MyClass, format=..., extension=..., save=..., load=...)``.
find_for_value : function
    Look up a registered entry by walking ``type(value).__mro__``.
find_for_format : function
    Look up a registered entry by its format name (used during load).
get_registry : function
    Snapshot of registered serializers, for tests and debugging.
clear : function
    Drop all registered serializers (used in tests).

See Also
--------
pdv_kernel.serialization (consumer of this registry)
ARCHITECTURE.md §7.2 (node types)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from pdv_kernel.errors import PDVSerializationError


@dataclass
class SerializerEntry:
    """One registered serializer mapping a type to save/load callbacks."""

    cls: type
    format: str
    extension: str
    save: Callable[[Any, str], None]
    load: Callable[[str], Any]
    preview: Optional[Callable[[Any], str]]
    class_name: str  # fully qualified: "module.Class"


_serializer_registry: dict[type, SerializerEntry] = {}
_format_index: dict[str, SerializerEntry] = {}


# Format names reserved by builtin serializers in pdv_kernel.serialization.
# Listed inline (rather than imported) to avoid a circular import — the
# constants in serialization.py are the source of truth and these strings
# must stay in sync.
_RESERVED_FORMATS: frozenset[str] = frozenset({
    "npy",
    "parquet",
    "json",
    "txt",
    "pickle",
    "py_script",
    "markdown",
    "inline",
    "gui_json",
    "module_meta",
    "namelist",
    "py_lib",
    "bin",
    "none",
})


def register(
    cls: type,
    *,
    format: str,
    extension: str = ".bin",
    save: Callable[[Any, str], None],
    load: Callable[[str], Any],
    preview: Optional[Callable[[Any], str]] = None,
) -> None:
    """Register a custom serializer for instances of *cls*.

    PDV will choose the on-disk filename and pass an absolute path to the
    ``save`` callback. The callback writes the object's state to that path
    however it likes. ``load`` receives the same path on project load and
    must return a reconstructed instance.

    Parameters
    ----------
    cls : type
        The type to register a serializer for. Lookup walks the MRO, so a
        serializer registered on a base class also covers subclasses.
    format : str
        Unique format identifier stored in ``tree-index.json`` so the right
        loader can be found at load time. Must not collide with any builtin
        format name (``npy``, ``parquet``, ``pickle``, ...).
    extension : str
        File extension PDV appends to the chosen filename. Leading ``.`` is
        added if missing. Defaults to ``".bin"``.
    save : callable
        ``save(obj, abs_path) -> None``. Writes the object's state to
        ``abs_path``. May raise; PDV wraps errors with the tree path.
    load : callable
        ``load(abs_path) -> obj``. Reads the file PDV wrote and returns the
        reconstructed instance.
    preview : callable, optional
        ``preview(obj) -> str``. Short human-readable preview shown in the
        tree panel. Falls back to a generic ``"<ClassName>"`` string when
        not supplied.

    Raises
    ------
    PDVSerializationError
        If ``format`` is empty, collides with a builtin format, or
        ``cls`` is not a class.
    """
    if not isinstance(cls, type):
        raise PDVSerializationError(
            f"register_serializer: first argument must be a class, got {type(cls).__name__}"
        )
    if not isinstance(format, str) or not format:
        raise PDVSerializationError(
            "register_serializer: 'format' must be a non-empty string"
        )
    if format in _RESERVED_FORMATS:
        raise PDVSerializationError(
            f"register_serializer: format '{format}' collides with a builtin format name"
        )
    if not callable(save) or not callable(load):
        raise PDVSerializationError(
            "register_serializer: 'save' and 'load' must be callables"
        )

    ext = extension or ".bin"
    if not ext.startswith("."):
        ext = "." + ext

    class_name = f"{cls.__module__}.{cls.__qualname__}"

    if format in _format_index and _format_index[format].cls is not cls:
        import warnings  # noqa: PLC0415

        old = _format_index[format]
        warnings.warn(
            f"Serializer format '{format}' overwritten "
            f"(was {old.class_name}, now {class_name})"
        )
        # Drop the old class binding so the registry stays consistent.
        _serializer_registry.pop(old.cls, None)

    if cls in _serializer_registry:
        import warnings  # noqa: PLC0415

        old = _serializer_registry[cls]
        warnings.warn(
            f"Serializer for {class_name} overwritten (was format '{old.format}')"
        )
        _format_index.pop(old.format, None)

    entry = SerializerEntry(
        cls=cls,
        format=format,
        extension=ext,
        save=save,
        load=load,
        preview=preview,
        class_name=class_name,
    )
    _serializer_registry[cls] = entry
    _format_index[format] = entry


def find_for_value(value: Any) -> Optional[SerializerEntry]:
    """Return the registered serializer matching *value*'s type, or None.

    Walks ``type(value).__mro__`` so subclasses inherit a base class's
    registration.
    """
    for cls in type(value).__mro__:
        entry = _serializer_registry.get(cls)
        if entry is not None:
            return entry
    return None


def find_for_format(format: str) -> Optional[SerializerEntry]:
    """Return the registered serializer for *format*, or None."""
    return _format_index.get(format)


def get_registry() -> dict[str, str]:
    """Return ``{class_name: format}`` for all registered serializers."""
    return {entry.class_name: entry.format for entry in _serializer_registry.values()}


def clear() -> None:
    """Drop all registered serializers. Used in tests."""
    _serializer_registry.clear()
    _format_index.clear()
