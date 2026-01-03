"""Logical result window capable of rendering diverse result types."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional

from platform.gui.client import InvokeResult


@dataclass
class DisplayResult:
    """Normalized representation of a method invocation outcome."""

    method_name: str
    result_type: str
    content: Any
    error: Optional[str] = None
    traceback: Optional[str] = None

    @property
    def is_error(self) -> bool:
        """True when the display represents a failure."""
        return self.error is not None


class ResultWindow:
    """Collect and normalize invocation results for presentation."""

    def __init__(self) -> None:
        self.history: List[DisplayResult] = []

    def add_result(self, result: InvokeResult) -> DisplayResult:
        """Store a result and return its display-ready representation."""
        display = self._normalize(result)
        self.history.append(display)
        return display

    def latest(self) -> Optional[DisplayResult]:
        """Return the most recent result if available."""
        if not self.history:
            return None
        return self.history[-1]

    def clear(self) -> None:
        """Remove all stored results."""
        self.history.clear()

    def _normalize(self, result: InvokeResult) -> DisplayResult:
        result_type = result.result_type or self._detect_type(result.result)
        if result.error:
            return DisplayResult(
                method_name=result.method_name,
                result_type="error",
                content=result.result,
                error=result.error,
                traceback=result.traceback,
            )
        normalized_content: Any = result.result
        if result_type == "text":
            normalized_content = "" if result.result is None else str(result.result)
        return DisplayResult(
            method_name=result.method_name,
            result_type=result_type,
            content=normalized_content,
            error=result.error,
            traceback=result.traceback,
        )

    def _detect_type(self, content: Any) -> str:
        if isinstance(content, (bytes, bytearray)):
            return "image"
        if isinstance(content, str):
            return "text"
        if isinstance(content, (dict, list, tuple, set)):
            return "data"
        return "object"
