from platform.gui.data_viewer import VirtualScroller


def test_visible_range_applies_overscan_and_bounds():
    scroller = VirtualScroller(viewport_size=10, overscan=2)
    start, end = scroller.visible_range(total_items=50, start_index=5)
    assert start == 3
    assert end == 17

    start, end = scroller.visible_range(total_items=5, start_index=4)
    assert start == 2
    assert end == 5


def test_window_returns_expected_slice():
    scroller = VirtualScroller(viewport_size=5, overscan=1)
    items = list(range(15))
    assert scroller.window(items, start_index=6) == items[5:12]
