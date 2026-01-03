from platform.gui.window_manager import WindowManager


def test_window_manager_tracks_multiple_windows():
    manager = WindowManager()
    first = manager.create_window(title="Main", session_id="one")
    second = manager.create_window(title="Secondary", session_id="two", route="/secondary", dev_mode=True)

    assert manager.count == 2
    assert first.window_id != second.window_id
    assert manager.get_window(first.window_id) is first
    assert manager.get_window(second.window_id) is second
    assert second.dev_mode is True
    assert second.route == "/secondary"

    manager.close_window(first.window_id)
    assert manager.count == 1
    assert manager.get_window(first.window_id) is None
    assert list(manager.list_windows())[0].window_id == second.window_id
