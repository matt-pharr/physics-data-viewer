from __future__ import annotations

from time import perf_counter

from platform.gui.data_viewer import DataViewer


def test_flatten_10k_items_under_target_time():
    data = list(range(10_000))
    viewer = DataViewer(data, viewport_size=500)

    start = perf_counter()
    visible = viewer.tree.flatten_visible()
    elapsed = perf_counter() - start

    # root node + 10k children should be present
    assert len(visible) == 10_001
    assert elapsed < 0.1


def test_virtual_window_handles_thousand_items():
    data = list(range(1_200))
    viewer = DataViewer(data, viewport_size=100, overscan=50)

    window = viewer.visible_window(start_index=200)
    assert len(window) <= 200  # viewport + overscan bounds
    depths = {depth for depth, _ in window}
    assert depths.issubset({0, 1})
