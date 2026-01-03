"""Utilities for detecting show/plot capabilities on objects."""

from __future__ import annotations

import inspect
from typing import Any, Callable, Dict


def _has_method(obj: Any, name: str) -> bool:
    candidate = getattr(obj, name, None)
    if candidate is None or not callable(candidate):
        return False
    try:
        signature = inspect.signature(candidate)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    params = list(signature.parameters.values())
    required = [
        param
        for param in params
        if param.default is inspect._empty
        and param.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        )
    ]
    if not required:
        return True
    # allow a single required self parameter for unbound methods
    return len(required) == 1 and required[0].name in {"self"}


def supports_show(obj: Any) -> bool:
    """Return True if the object exposes a show() method."""
    return _has_method(obj, "show")


def supports_plot(obj: Any) -> bool:
    """Return True if the object exposes a plot() method."""
    return _has_method(obj, "plot")


def describe_capabilities(obj: Any) -> Dict[str, bool]:
    """Return a capability map for show/plot support."""
    return {"show": supports_show(obj), "plot": supports_plot(obj)}
