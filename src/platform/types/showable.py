"""Protocols for showable and plottable custom data types."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Showable(Protocol):
    """Protocol for objects that can present a textual representation."""

    def show(self) -> str:
        """Return a string representation for display."""


@runtime_checkable
class Plottable(Protocol):
    """Protocol for objects that can generate a visualization."""

    def plot(self) -> Any:
        """Return a visualization object for plotting."""


@runtime_checkable
class ShowablePlottable(Showable, Plottable, Protocol):
    """Protocol combining show and plot capabilities."""

    def show(self) -> str:  # pragma: no cover - defined in parent
        ...

    def plot(self) -> Any:  # pragma: no cover - defined in parent
        ...


__all__ = ["Showable", "Plottable", "ShowablePlottable"]
