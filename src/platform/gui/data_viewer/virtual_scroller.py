"""Virtual scrolling helper for large item collections."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class VirtualScroller:
    """Compute visible windows for large datasets."""

    viewport_size: int
    overscan: int = 10

    def __post_init__(self) -> None:
        if self.viewport_size <= 0:
            raise ValueError("viewport_size must be positive.")
        if self.overscan < 0:
            raise ValueError("overscan cannot be negative.")

    def visible_range(self, *, total_items: int, start_index: int = 0) -> tuple[int, int]:
        """Return (start, end) indices for a window."""
        if total_items < 0:
            raise ValueError("total_items cannot be negative.")
        clamped_start = max(0, start_index)
        start = max(0, clamped_start - self.overscan)
        end = min(total_items, clamped_start + self.viewport_size + self.overscan)
        return start, end

    def window(self, items: list, start_index: int = 0) -> list:
        """Return the items within the computed visible range."""
        start, end = self.visible_range(total_items=len(items), start_index=start_index)
        return items[start:end]


__all__ = ["VirtualScroller"]
