from fastapi.testclient import TestClient

from platform.server.app import create_app


def test_create_session_and_execute_code():
    app = create_app()
    with TestClient(app) as client:
        session_resp = client.post("/sessions", json={})
        session_id = session_resp.json()["session_id"]

        exec_resp = client.post(
            "/execute",
            json={"code": "value = 10\nprint(value)", "session_id": session_id},
        )
        data = exec_resp.json()

        assert data["session_id"] == session_id
        assert data["state"]["value"] == 10
        assert "10" in data["stdout"]

        state_resp = client.get(f"/state/{session_id}")
        assert state_resp.json()["value"] == 10


def test_execute_creates_session_when_missing():
    app = create_app()
    with TestClient(app) as client:
        exec_resp = client.post("/execute", json={"code": "x = 1"})
        data = exec_resp.json()

        assert data["session_id"]
        assert data["state"]["x"] == 1

        state_resp = client.get(f"/state/{data['session_id']}")
        assert state_resp.status_code == 200
