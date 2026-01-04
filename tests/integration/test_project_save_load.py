from __future__ import annotations

from fastapi.testclient import TestClient

from platform.server.app import create_app
from platform.state.project_tree import LazyNode, Tree


def test_save_and_load_project_archive_round_trip():
    app = create_app()
    project_tree: Tree = app.state.project_tree
    project_tree.reset(clear_observers=True)

    project_tree["constants"] = Tree({"pi": 3.14})

    def loader() -> Tree:
        branch = Tree()
        branch["samples"] = [0, 1, 2]
        return branch

    project_tree.add_lazy("datasets", loader, metadata={"handle": "hdf5://experiment", "preview": "datasets"})

    with TestClient(app) as client:
        save_resp = client.get("/project/save")
        assert save_resp.status_code == 200
        archive = save_resp.content

        project_tree.reset(clear_observers=False)
        project_tree["constants"] = {"pi": 0}

        load_resp = client.post(
            "/project/load",
            files={"file": ("project.pdz", archive, "application/octet-stream")},
        )
        assert load_resp.status_code == 200
        payload = load_resp.json()
        assert payload["status"] == "ok"
        assert "constants" in payload["root_keys"]

    assert isinstance(project_tree._data["datasets"], LazyNode)  # noqa: SLF001
    assert project_tree["constants"]["pi"] == 3.14
    resolved = project_tree["datasets"]
    assert isinstance(resolved, Tree)
    assert resolved["samples"][1] == 1


def test_load_endpoint_rejects_invalid_archives():
    app = create_app()
    with TestClient(app) as client:
        resp = client.post(
            "/project/load",
            files={"file": ("corrupt.pdz", b"garbage", "application/octet-stream")},
        )
        assert resp.status_code == 400
