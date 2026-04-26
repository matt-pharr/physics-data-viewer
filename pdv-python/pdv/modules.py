"""
pdv.modules — Handler registry, decorator, and dispatch for custom type handlers.

Module developers use ``@pdv.handle(MyClass)`` to register a handler function
that is invoked when a user double-clicks a tree node whose value is an instance
of ``MyClass``. Handlers are resolved by walking the MRO, so a handler
registered on a base class also applies to subclasses.

Public API
----------
handle : decorator factory
    ``@pdv.handle(MyClass)`` registers a handler for instances of MyClass.
has_handler_for : function
    Check whether any registered handler matches an object's type (via MRO).
dispatch_handler : function
    Find and call the appropriate handler for an object.
get_handler_registry : function
    Return a snapshot of all registered handlers.
clear_handlers : function
    Clear the handler registry (used in tests).

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class HandlerEntry:
    """One registered handler mapping a type to a callable."""

    cls: type
    func: Callable
    class_name: str  # fully qualified: "module.Class"


_handler_registry: dict[type, HandlerEntry] = {}


def handle(cls: type) -> Callable:
    """Decorator factory: register a handler for instances of *cls*.

    Usage::

        @pdv.handle(MyClass)
        def on_my_class(obj, path, pdv_tree):
            ...

    Parameters
    ----------
    cls : type
        The type to register a handler for.

    Returns
    -------
    Callable
        A decorator that registers the wrapped function.
    """

    def decorator(func: Callable) -> Callable:
        class_name = f"{cls.__module__}.{cls.__qualname__}"
        if cls in _handler_registry:
            import warnings

            old = _handler_registry[cls]
            warnings.warn(
                f"Handler for {class_name} overwritten (was {old.func.__qualname__})"
            )
        _handler_registry[cls] = HandlerEntry(cls=cls, func=func, class_name=class_name)
        return func

    return decorator


def has_handler_for(obj: Any) -> bool:
    """Check whether any registered handler matches *obj*'s type via MRO.

    Parameters
    ----------
    obj : Any
        The object to check.

    Returns
    -------
    bool
        True if a handler is registered for ``type(obj)`` or any of its bases.
    """
    for cls in type(obj).__mro__:
        if cls in _handler_registry:
            return True
    return False


def dispatch_handler(obj: Any, path: str, pdv_tree: Any) -> dict:
    """Find and call the handler for *obj*.

    Parameters
    ----------
    obj : Any
        The tree node value.
    path : str
        Dot-separated tree path of the node.
    pdv_tree : Any
        The PDVTree instance.

    Returns
    -------
    dict
        ``{"dispatched": True}`` on success, or
        ``{"dispatched": False, "error": "..."}`` when no handler matches.
    """
    for cls in type(obj).__mro__:
        if cls in _handler_registry:
            _handler_registry[cls].func(obj, path, pdv_tree)
            return {"dispatched": True}
    t = type(obj)
    return {
        "dispatched": False,
        "error": f"No handler for {t.__module__}.{t.__qualname__}",
    }


def get_handler_registry() -> dict[str, str]:
    """Return ``{class_name: handler_func_name}`` for all registered handlers.

    Returns
    -------
    dict[str, str]
        Mapping from fully qualified class name to handler function qualname.
    """
    return {
        entry.class_name: entry.func.__qualname__
        for entry in _handler_registry.values()
    }


def clear_handlers() -> None:
    """Clear the handler registry. Used in tests."""
    _handler_registry.clear()
