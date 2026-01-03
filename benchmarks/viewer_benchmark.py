"""Simple benchmark for the data viewer tree flattening."""

from __future__ import annotations

from time import perf_counter

from platform.gui.data_viewer import DataViewer


def run_benchmark(item_count: int = 50_000) -> float:
    """Return elapsed time for flattening a synthetic dataset."""
    data = list(range(item_count))
    viewer = DataViewer(data, viewport_size=500)
    start = perf_counter()
    viewer.tree.flatten_visible()
    return perf_counter() - start


if __name__ == "__main__":  # pragma: no cover
    duration = run_benchmark()
    print(f"Flattened {50_000} items in {duration:.4f}s")
