import httpx
import pytest

from platform.gui.client import BackendClient
from platform.server.app import create_app


@pytest.mark.asyncio
async def test_backend_client_execute_roundtrip():
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        backend = BackendClient("http://test", client=client)
        session_id = await backend.connect()
        result = await backend.execute("value = 2 + 3", session_id=session_id)

        assert result.success
        assert result.error is None
        assert result.stderr == ""

        state = await backend.get_state(session_id)
        assert state["value"] == 5
