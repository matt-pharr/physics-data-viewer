"""Virtual-children protocol for tree nodes.

Some tree values expose *virtual* children — children that are browsable
in the tree panel and addressable by dot-path, but are not real tree
entries backed by ``PDVTree`` dict storage. The canonical examples are a
live ``xarray.Dataset`` (its variables and coordinates) and the new
file-backed dataset nodes (``PDVDataset``/``PDVHdf5``), whose children
come from an on-demand file-header read.

This module defines the single dispatch point for that behavior. Two ways
to participate:

- **PDV-owned classes** implement the dunder protocol directly:
  ``__pdv_children__()`` returning a list of :data:`ChildEntry`,
  ``__pdv_child__(key)`` for single-child lookup, and optionally
  ``__pdv_has_children__()`` (cheap, must never raise).
- **Foreign types** (objects PDV does not own, e.g. ``xarray.Dataset``,
  ``h5py.Group``) are matched by predicate through a registry of
  :class:`VirtualAdapter` instances — see :func:`register_virtual`.

Consumers call :func:`get_virtual_adapter` and, when it returns an
adapter, treat the value as an expandable container. The three consumers
are ``PDVTree._resolve_nested`` (dot-path descent), and the enumeration
and ``has_children`` computations in ``pdv.handlers.tree.handle_tree_list``.

This module deliberately imports none of the optional scientific
libraries; built-in foreign predicates use the ``sys.modules`` guard
idiom from :mod:`pdv.serialization` so they are safe on the QueryServer
thread and never trigger an import.
"""

from __future__ import annotations

from typing import Any, Callable

# One virtual child: (key, live value, descriptor overrides or None).
# The live value is included because tree.list needs it for kind
# detection, previews, and handler lookup; overrides are merged onto the
# computed node descriptor last (e.g. {"is_coord": True}).
ChildEntry = tuple[str, Any, "dict[str, Any] | None"]


class VirtualAdapter:
    """Adapter giving one foreign container type virtual-children behavior.

    Subclasses override all three methods. ``children``/``child`` may
    raise (missing optional dependency, unreadable file, absent key) —
    callers surface those as user-facing errors. ``has_children`` must be
    cheap and must never raise; it is called for every sibling row on
    every tree listing.
    """

    def children(self, obj: Any) -> "list[ChildEntry]":
        """Return all virtual children of ``obj``.

        Parameters
        ----------
        obj : Any
            The container object this adapter was matched against.

        Returns
        -------
        list[ChildEntry]
            ``(key, value, overrides)`` per child, in display order.
        """
        raise NotImplementedError

    def child(self, obj: Any, key: str) -> Any:
        """Return the single virtual child ``key`` of ``obj``.

        Raises
        ------
        KeyError
            If ``key`` is not a child of ``obj``.
        """
        raise NotImplementedError

    def has_children(self, obj: Any) -> bool:
        """Return True if ``obj`` has at least one virtual child.

        Must be cheap and must never raise.
        """
        raise NotImplementedError


class _DunderAdapter(VirtualAdapter):
    """Adapter dispatching to the ``__pdv_children__`` dunder protocol."""

    def children(self, obj: Any) -> "list[ChildEntry]":
        return list(obj.__pdv_children__())

    def child(self, obj: Any, key: str) -> Any:
        return obj.__pdv_child__(key)

    def has_children(self, obj: Any) -> bool:
        probe = getattr(obj, "__pdv_has_children__", None)
        if probe is not None:
            try:
                return bool(probe())
            except Exception:
                return False
        try:
            return len(obj.__pdv_children__()) > 0
        except Exception:
            return False


class _XarrayDatasetAdapter(VirtualAdapter):
    """Virtual children of a live ``xarray.Dataset``: data_vars + coords."""

    def children(self, obj: Any) -> "list[ChildEntry]":
        entries: list[ChildEntry] = [
            (str(name), obj[name], None) for name in obj.data_vars
        ]
        entries.extend(
            (str(name), obj[name], {"is_coord": True}) for name in obj.coords
        )
        return entries

    def child(self, obj: Any, key: str) -> Any:
        # Dataset.__getitem__ resolves both data_vars and coords by name.
        try:
            return obj[key]
        except KeyError:
            raise KeyError(key) from None

    def has_children(self, obj: Any) -> bool:
        try:
            # ``variables`` covers data_vars and coords.
            return len(obj.variables) > 0
        except Exception:
            return False


class _H5pyGroupAdapter(VirtualAdapter):
    """Virtual children of an ``h5py.Group`` (or ``File``): its members."""

    def children(self, obj: Any) -> "list[ChildEntry]":
        return [(str(name), obj[name], None) for name in obj.keys()]

    def child(self, obj: Any, key: str) -> Any:
        try:
            return obj[key]
        except KeyError:
            raise KeyError(key) from None

    def has_children(self, obj: Any) -> bool:
        try:
            return len(obj) > 0
        except Exception:
            return False


_DUNDER_ADAPTER = _DunderAdapter()


def _is_live_xarray_dataset(value: Any) -> bool:
    from pdv.serialization import is_xarray_dataset  # noqa: PLC0415

    return is_xarray_dataset(value)


def _is_h5py_group(value: Any) -> bool:
    from pdv.serialization import is_h5py_group  # noqa: PLC0415

    return is_h5py_group(value)


# Registry of (predicate, adapter) pairs for foreign types, checked in
# registration order. Predicates must be cheap and exception-free (the
# built-ins only probe sys.modules + isinstance).
_REGISTRY: "list[tuple[Callable[[Any], bool], VirtualAdapter]]" = [
    (_is_live_xarray_dataset, _XarrayDatasetAdapter()),
    (_is_h5py_group, _H5pyGroupAdapter()),
]


def register_virtual(
    predicate: Callable[[Any], bool], adapter: VirtualAdapter
) -> None:
    """Register a virtual-children adapter for a foreign container type.

    Parameters
    ----------
    predicate : Callable[[Any], bool]
        Matcher called with candidate values. Must be cheap and never
        raise; prefer the ``sys.modules`` guard idiom over importing the
        library the type comes from.
    adapter : VirtualAdapter
        Adapter used for values the predicate matches.
    """
    _REGISTRY.append((predicate, adapter))


def get_virtual_adapter(value: Any) -> "VirtualAdapter | None":
    """Return the virtual-children adapter for ``value``, if any.

    Checks the dunder protocol first (``__pdv_children__`` defined on the
    type), then the foreign-type registry in registration order.

    Parameters
    ----------
    value : Any
        Candidate container value.

    Returns
    -------
    VirtualAdapter or None
        The matching adapter, or None if ``value`` has no virtual
        children behavior.
    """
    if hasattr(type(value), "__pdv_children__"):
        return _DUNDER_ADAPTER
    for predicate, adapter in _REGISTRY:
        if predicate(value):
            return adapter
    return None
