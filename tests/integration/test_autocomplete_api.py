"""Integration tests for autocomplete API endpoint."""

from fastapi.testclient import TestClient

from platform.server.app import create_app


def test_autocomplete_endpoint_keyword():
    """Test autocomplete endpoint returns Python keywords."""
    app = create_app()
    with TestClient(app) as client:
        # Create a session first
        session_resp = client.post("/sessions")
        assert session_resp.status_code == 200
        session_id = session_resp.json()["session_id"]

        # Request autocomplete
        resp = client.post(
            "/autocomplete",
            json={
                "session_id": session_id,
                "code": "imp",
                "cursor_position": 3,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "completions" in data
        assert "import" in data["completions"]


def test_autocomplete_endpoint_with_state():
    """Test autocomplete endpoint includes state variables."""
    app = create_app()
    with TestClient(app) as client:
        # Create a session and execute code to populate state
        session_resp = client.post("/sessions")
        session_id = session_resp.json()["session_id"]

        client.post(
            "/execute",
            json={
                "session_id": session_id,
                "code": "my_variable = 42\nmy_value = 'test'",
            },
        )

        # Request autocomplete
        resp = client.post(
            "/autocomplete",
            json={
                "session_id": session_id,
                "code": "my_",
                "cursor_position": 3,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "my_variable" in data["completions"]
        assert "my_value" in data["completions"]


def test_autocomplete_endpoint_nonexistent_session():
    """Test autocomplete endpoint with nonexistent session returns 404."""
    app = create_app()
    with TestClient(app) as client:
        resp = client.post(
            "/autocomplete",
            json={
                "session_id": "nonexistent",
                "code": "imp",
                "cursor_position": 3,
            },
        )
        assert resp.status_code == 404


def test_autocomplete_endpoint_default_cursor():
    """Test autocomplete endpoint with default cursor position."""
    app = create_app()
    with TestClient(app) as client:
        session_resp = client.post("/sessions")
        session_id = session_resp.json()["session_id"]

        resp = client.post(
            "/autocomplete",
            json={
                "session_id": session_id,
                "code": "pri",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "print" in data["completions"]


def test_autocomplete_endpoint_builtins():
    """Test autocomplete endpoint returns Python builtins."""
    app = create_app()
    with TestClient(app) as client:
        session_resp = client.post("/sessions")
        session_id = session_resp.json()["session_id"]

        resp = client.post(
            "/autocomplete",
            json={
                "session_id": session_id,
                "code": "pri",
                "cursor_position": 3,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "print" in data["completions"]


def test_autocomplete_endpoint_empty_completions():
    """Test autocomplete endpoint returns empty list when no matches."""
    app = create_app()
    with TestClient(app) as client:
        session_resp = client.post("/sessions")
        session_id = session_resp.json()["session_id"]

        resp = client.post(
            "/autocomplete",
            json={
                "session_id": session_id,
                "code": "xyzabc",
                "cursor_position": 6,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["completions"] == []


def test_autocomplete_multiline_code():
    """Test autocomplete with multiline code."""
    app = create_app()
    with TestClient(app) as client:
        session_resp = client.post("/sessions")
        session_id = session_resp.json()["session_id"]

        code = "x = 1\ny = 2\nimp"
        resp = client.post(
            "/autocomplete",
            json={
                "session_id": session_id,
                "code": code,
                "cursor_position": len(code),
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "import" in data["completions"]
