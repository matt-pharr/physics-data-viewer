import httpx
import pytest

from platform.gui.client import BackendClient
from platform.gui.data_viewer import DataViewer, DoubleClickInvoker
from platform.gui.result_display import ResultWindow
from platform.server.app import create_app
from platform.server.state import StateManager


class Demo:
    def __init__(self) -> None:
        self.calls = 0

    def show(self) -> str:
        self.calls += 1
        return f"demo-call-{self.calls}"


class PlotOnly:
    def plot(self):
        return {"points": [[1, 2]]}


class Erroring:
    def show(self):
        raise ValueError("boom")


@pytest.mark.asyncio
async def test_double_click_invocation_populates_result_window():
    app = create_app()
    state: StateManager = app.state.state_manager
    session = state.create_session("double-click")

    state.set_nested(session, ["demo"], Demo())
    state.set_nested(session, ["plot"], PlotOnly())
    state.set_nested(session, ["error"], Erroring())

    viewer = DataViewer(state.get_session_state(session))
    demo_node = viewer.tree.root.find_by_path(("root", "demo"))
    plot_node = viewer.tree.root.find_by_path(("root", "plot"))
    error_node = viewer.tree.root.find_by_path(("root", "error"))

    assert demo_node is not None and plot_node is not None and error_node is not None

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        backend = BackendClient("http://test", client=client)
        invoker = DoubleClickInvoker(backend, ResultWindow())

        demo_result = await invoker.handle_double_click(session, demo_node)
        assert demo_result.result_type == "text"
        assert "demo-call-1" in demo_result.content

        plot_result = await invoker.handle_double_click(session, plot_node)
        assert plot_result.result_type == "plot"
        assert plot_result.content == {"points": [[1, 2]]}

        error_result = await invoker.handle_double_click(session, error_node)
        assert error_result.is_error
        assert "ValueError" in (error_result.traceback or "")
