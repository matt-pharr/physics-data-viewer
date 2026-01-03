import httpx
import pytest

from platform.gui import FrontendApp
from platform.gui.client import BackendClient
from platform.server.app import create_app


@pytest.mark.asyncio
async def test_frontend_app_start_and_hot_reload():
    backend_app = create_app()
    transport = httpx.ASGITransport(app=backend_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        backend_client = BackendClient("http://test", client=client)
        frontend = FrontendApp(backend_url="http://test", client=backend_client)

        main_window = await frontend.start(dev_mode=True)
        assert frontend.window_manager.count == 1
        assert main_window.session_id == frontend.default_session_id
        assert main_window.window_id is not None
        assert main_window.title == "Physics Data Viewer"

        execute_result = await frontend.send_command("alpha = 10")
        assert execute_result.success

        secondary = await frontend.new_window("Second")
        second_result = await frontend.send_command("beta = 5", window_id=secondary.window_id)
        assert second_result.session_id == secondary.session_id

        await frontend.trigger_hot_reload()
        assert frontend.window_manager.count == 2
        restored_ids = {w.window_id for w in frontend.window_manager.list_windows()}
        assert main_window.window_id in restored_ids
        assert secondary.window_id in restored_ids
        await frontend.shutdown()


@pytest.mark.asyncio
async def test_frontend_app_rejects_unknown_window():
    backend_app = create_app()
    transport = httpx.ASGITransport(app=backend_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        backend_client = BackendClient("http://test", client=client)
        frontend = FrontendApp(backend_url="http://test", client=backend_client)
        await frontend.start()
        with pytest.raises(ValueError):
            await frontend.send_command("x=1", window_id="missing")
        await frontend.shutdown()
