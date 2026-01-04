from __future__ import annotations

import pytest

from platform.state.project_io import ProjectIOError, load_project_tree, serialize_project_tree
from platform.state.project_tree import LazyNode, Tree, get_project_tree


@pytest.fixture(autouse=True)
def project_tree():
    tree = get_project_tree()
    tree.reset(clear_observers=True)
    yield tree
    tree.reset(clear_observers=True)


def test_round_trip_persists_lazy_nodes_and_metadata(project_tree: Tree):
    calls: list[str] = []

    def loader() -> Tree:
        calls.append("loaded")
        branch = Tree()
        branch["values"] = [1, 2, 3]
        return branch

    project_tree["constants"] = Tree({"pi": 3.14})
    project_tree.set_metadata("constants", {"unit": "dimensionless"})
    project_tree.add_lazy("waveforms", loader, metadata={"handle": "hdf5://experiment", "preview": "lazy-wave"})

    archive = serialize_project_tree(project_tree)
    assert calls == ["loaded"]  # snapshot captured without marking as resolved

    project_tree["constants"] = {"pi": 0}
    loaded = load_project_tree(archive, target=project_tree)

    assert isinstance(loaded._data["waveforms"], LazyNode)  # noqa: SLF001
    assert loaded.get_metadata("constants")["unit"] == "dimensionless"
    assert calls == ["loaded"]

    resolved = loaded["waveforms"]
    assert isinstance(resolved, Tree)
    assert resolved["values"][-1] == 3
    assert calls == ["loaded"]


def test_invalid_archive_raises(project_tree: Tree):
    with pytest.raises(ProjectIOError):
        load_project_tree(b"not-a-zip", target=project_tree)
