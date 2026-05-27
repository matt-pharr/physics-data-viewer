"""
pdv.serializers — Custom serializer registry and dunder protocol for custom types.

PDV supports two extension paths for persisting instances of a custom class:

1. **Registered serializers.** A module developer calls
   ``pdv.register_serializer(MyClass, format=..., extension=..., save=..., load=...)``
   to attach save/load callbacks to a class they may not own (e.g.
   ``scipy.sparse.csr_matrix``). This is the only supported way to save
   objects whose state lives outside Python (ctypes pointers, Fortran library
   handles, GPU buffers, ...).
2. **Dunder protocol.** A class the package author defines may opt in by
   implementing ``__pdv_format__`` / ``__pdv_serialize__`` /
   ``__pdv_deserialize__`` (required as a set) plus the optional
   ``__pdv_preview__``, ``__pdv_handle__``, and ``__pdv_digest__`` methods.
   The defining package never imports ``pdv``; load-time class recovery uses
   the descriptor's ``python_type`` metadata and ``importlib.import_module``.

Registered serializers take precedence over the dunder protocol when both
exist for the same class — explicit registration is the way to override a
class's own intent for types you don't own.

Public API
----------
register : function
    ``pdv.register_serializer(MyClass, format=..., extension=..., save=..., load=...)``.
find_for_value : function
    Look up a registered entry by walking ``type(value).__mro__``.
find_for_format : function
    Look up a registered entry by its format name (used during load).
find_for_value_dunder : function
    Synthesize a :class:`DunderEntry` from a value's dunder methods, or None.
find_for_format_dunder : function
    Recover the class for a dunder-served format by importing ``python_type``.
get_registry : function
    Snapshot of registered serializers, for tests and debugging.
clear : function
    Drop all registered serializers and dunder caches (used in tests).

See Also
--------
pdv.serialization (consumer of this registry)
pdv.modules (companion ``@pdv.handle`` decorator and ``__pdv_handle__`` fallback)
ARCHITECTURE.md §7.2 (node types)
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any, Callable, Optional

from pdv.errors import PDVSerializationError


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


@dataclass
class DunderEntry:
    """A class's dunder-protocol opt-in, synthesized from its methods."""

    cls: type
    format: str
    extension: str
    class_name: str  # fully qualified: "module.Class"


# Per-type cache; None marks a class that has been checked and found not to
# implement the full trio. Cleared by :func:`clear`.
_dunder_cache: dict[type, Optional[DunderEntry]] = {}

# Maps (format, python_type) -> class object so we don't re-import on every
# subsequent load of the same format.
_dunder_format_cache: dict[tuple[str, str], type] = {}


# Format names reserved by builtin serializers in pdv.serialization.
# Listed inline (rather than imported) to avoid a circular import — the
# constants in serialization.py are the source of truth and these strings
# must stay in sync.
_RESERVED_FORMATS: frozenset[str] = frozenset(
    {
        "npy",
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
    }
)


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
        format name (``npy``, ``pickle``, ``json``, ...).
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


def find_for_value_dunder(value: Any) -> Optional[DunderEntry]:
    """Return a :class:`DunderEntry` for *value*'s class, or ``None``.

    A class opts into the dunder protocol by defining all three of
    ``__pdv_format__`` (classmethod returning ``(format_name, extension)``),
    ``__pdv_serialize__`` (instance method writing the value to a path), and
    ``__pdv_deserialize__`` (classmethod reading the file back). When a class
    defines only one or two of those (the dunder names may be present on the
    class for unrelated reasons), this function returns ``None`` so the
    caller can fall through to the pickle fallback.

    Lookup is via standard ``hasattr`` on ``type(value)``, which walks the
    MRO. The result is cached per type.

    Parameters
    ----------
    value : Any
        The value PDV is about to serialize.

    Returns
    -------
    DunderEntry or None
        ``None`` when the class does not implement the full trio.

    Raises
    ------
    PDVSerializationError
        If ``__pdv_format__()`` raises, returns a non-(str, str) tuple, or
        returns a name that collides with a builtin format or with a
        :func:`register` entry for a *different* class.
    """
    cls = type(value)
    cached = _dunder_cache.get(cls)
    if cached is not None:
        return cached
    if cls in _dunder_cache:  # cached as None — definitively no protocol
        return None

    has_fmt = hasattr(cls, "__pdv_format__")
    has_ser = hasattr(cls, "__pdv_serialize__")
    has_des = hasattr(cls, "__pdv_deserialize__")
    present = sum((has_fmt, has_ser, has_des))
    if present < 3:
        # Partial trio: silently treat as "no protocol" so users may use any
        # of these names for unrelated reasons. Cache the negative result so
        # repeated saves are cheap.
        _dunder_cache[cls] = None
        return None

    class_name = f"{cls.__module__}.{cls.__qualname__}"

    try:
        result = cls.__pdv_format__()
    except Exception as exc:  # noqa: BLE001
        raise PDVSerializationError(
            f"Dunder protocol for '{class_name}': __pdv_format__() raised: {exc}"
        ) from exc

    if (
        not isinstance(result, tuple)
        or len(result) != 2
        or not isinstance(result[0], str)
        or not isinstance(result[1], str)
    ):
        raise PDVSerializationError(
            f"Class '{class_name}.__pdv_format__()' must return a 2-tuple of "
            f"(format_name: str, extension: str). Got: {result!r}"
        )

    fmt, ext = result
    if fmt in _RESERVED_FORMATS:
        raise PDVSerializationError(
            f"Dunder protocol for '{class_name}': format '{fmt}' collides with "
            f"a builtin format name. Choose a different name in __pdv_format__()."
        )

    existing = _format_index.get(fmt)
    if existing is not None and existing.cls is not cls:
        raise PDVSerializationError(
            f"Dunder protocol for '{class_name}': format '{fmt}' is already "
            f"registered via pdv.register_serializer for "
            f"'{existing.class_name}'. Choose a different name in "
            f"__pdv_format__() or remove the conflicting registration."
        )

    if not ext.startswith("."):
        ext = "." + ext

    entry = DunderEntry(cls=cls, format=fmt, extension=ext, class_name=class_name)
    _dunder_cache[cls] = entry
    return entry


def find_for_format_dunder(fmt: str, python_type: str) -> Optional[type]:
    """Recover a class implementing ``__pdv_deserialize__`` by importing it.

    On project load, PDV reads the descriptor's ``metadata.python_type``
    (e.g. ``"mypkg.geqdsk.GEqdskData"``) and asks this function to import the
    module, walk to the named class, and confirm it implements the dunder
    protocol. The defining package only needs to be installed — it does
    **not** need to be imported by the user before project load.

    Never raises: returns ``None`` for any failure mode (missing module,
    unknown attribute, class no longer implementing the protocol). The
    caller is expected to raise a descriptive ``PDVSerializationError`` that
    names the format and the ``python_type`` so the user knows what to install.

    Parameters
    ----------
    fmt : str
        The on-disk format identifier read from ``storage.format``. Used as
        part of the cache key.
    python_type : str
        Dotted path ``"module.qualname"``. Supports nested ``qualname`` via
        the inner-dot walk after the module split.

    Returns
    -------
    type or None
        The recovered class, or ``None`` if the import/resolution failed.
    """
    if not python_type:
        return None
    cache_key = (fmt, python_type)
    cached = _dunder_format_cache.get(cache_key)
    if cached is not None:
        return cached

    # Split on the *last* dot first; on failure walk leftwards so nested
    # qualnames like "pkg.mod.Outer.Inner" still resolve.
    head, sep, tail = python_type.rpartition(".")
    while head:
        try:
            module = importlib.import_module(head)
        except Exception:  # noqa: BLE001
            head, sep, rest = head.rpartition(".")
            tail = f"{rest}.{tail}" if sep else tail
            continue
        obj: Any = module
        try:
            for part in tail.split("."):
                obj = getattr(obj, part)
        except AttributeError:
            return None
        if not isinstance(obj, type):
            return None
        if not hasattr(obj, "__pdv_deserialize__"):
            return None
        _dunder_format_cache[cache_key] = obj
        return obj
    return None


def clear() -> None:
    """Drop all registered serializers and dunder caches. Used in tests."""
    _serializer_registry.clear()
    _format_index.clear()
    _dunder_cache.clear()
    _dunder_format_cache.clear()
