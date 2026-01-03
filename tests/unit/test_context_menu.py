import httpx
import pytest

from platform.gui.client import BackendClient
from platform.gui.context_menu import ContextMenuBuilder
from platform.server.app import create_app
from platform.server.state import StateManager


class Demo:
    def show(self) -> str:
        return "shown"

    def plot(self) -> str:
        return "plotted"

    def needs_args(self, value: int) -> int:
        return value


@pytest.mark.asyncio
async def test_context_menu_builds_items_and_routes_to_backend():
    app = create_app()
    state: StateManager = app.state.state_manager
    session = state.create_session("ctx")
    state.set_nested(session, ["root"], Demo())

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        backend = BackendClient("http://test", client=client)
        builder = ContextMenuBuilder(backend)

        menu = await builder.build(session, ["root"])
        labels = menu.labels()
        assert "show" in labels
        assert "plot" in labels
        needs_args = next((item for item in menu.items if item.method_name == "needs_args"), None)
        assert needs_args is not None
        assert not needs_args.enabled

        show_item = next((item for item in menu.items if item.method_name == "show"), None)
        assert show_item is not None
        result = await show_item.trigger()
        assert result == "shown"

        with pytest.raises(RuntimeError):
            await needs_args.trigger()
