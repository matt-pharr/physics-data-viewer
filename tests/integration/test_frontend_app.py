import asyncio

import httpx
import pytest

from platform.gui import FrontendApp
from platform.gui.client import BackendClient
from platform.server.app import create_app


def test_frontend_app_start_and_hot_reload():
    async def run():
        backend_app = create_app()
        transport = httpx.ASGITransport(app=backend_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            backend_client = BackendClient("http://test", client=client)
            frontend = FrontendApp(backend_url="http://test", client=backend_client)

            main_window = await frontend.start(dev_mode=True)
            assert frontend.window_manager.count == 1
            assert main_window.session_id == frontend.default_session_id

            execute_result = await frontend.send_command("alpha = 10")
            assert execute_result.success

            secondary = await frontend.new_window("Second")
            second_result = await frontend.send_command("beta = 5", window_id=secondary.window_id)
            assert second_result.session_id == secondary.session_id

            await frontend.trigger_hot_reload()
            assert frontend.window_manager.count == 2
            await frontend.shutdown()

    asyncio.run(run())


def test_frontend_app_rejects_unknown_window():
    async def run():
        backend_app = create_app()
        transport = httpx.ASGITransport(app=backend_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            backend_client = BackendClient("http://test", client=client)
            frontend = FrontendApp(backend_url="http://test", client=backend_client)
            await frontend.start()
            with pytest.raises(ValueError):
                await frontend.send_command("x=1", window_id="missing")
            await frontend.shutdown()

    asyncio.run(run())
