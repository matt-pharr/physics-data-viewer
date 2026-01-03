"""Utilities for summarizing values for tree display."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from platform.utils.introspection import describe_capabilities


@dataclass(frozen=True)
class FormattedValue:
    """Lightweight summary used by the data viewer."""

    preview: str
    type_name: str
    capabilities: Dict[str, bool]
    is_custom: bool


def _safe_repr(value: Any) -> str:
    try:
        return repr(value)
    except Exception:  # pragma: no cover - extremely defensive
        return "<unrepresentable>"


def format_value(value: Any) -> FormattedValue:
    """Return a formatted summary for a given value."""
    capabilities = describe_capabilities(value)
    is_custom = capabilities.get("show", False) or capabilities.get("plot", False)

    preview: str
    if capabilities.get("show"):
        try:
            preview = str(value.show())  # type: ignore[call-arg]
        except Exception:  # pragma: no cover - fallback to repr
            preview = _safe_repr(value)
    else:
        preview = _safe_repr(value)

    return FormattedValue(preview=preview, type_name=type(value).__name__, capabilities=capabilities, is_custom=is_custom)


__all__ = ["FormattedValue", "format_value"]
