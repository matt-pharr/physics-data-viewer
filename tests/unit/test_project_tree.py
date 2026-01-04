from __future__ import annotations

import pytest

from platform.state.project_tree import Tree, get_project_tree


@pytest.fixture(autouse=True)
def project_tree():
    tree = get_project_tree()
    tree.reset(clear_observers=True)
    yield tree
    tree.reset(clear_observers=True)


def test_project_tree_singleton_and_mapping_behavior(project_tree: Tree):
    other = get_project_tree()
    assert other is project_tree

    project_tree["alpha"] = 1
    project_tree.set_path(["beta", "inner"], 2)

    assert project_tree["alpha"] == 1
    nested = project_tree.get_path(["beta"])
    assert isinstance(nested, Tree)
    assert project_tree.get_path(["beta", "inner"]) == 2


def test_lazy_nodes_resolve_on_access(project_tree: Tree):
    calls: list[str] = []

    def loader() -> Tree:
        calls.append("loaded")
        branch = Tree()
        branch["values"] = [1, 2, 3]
        return branch

    project_tree.add_lazy("lazy_block", loader, preview="heavy-preview", metadata={"preview": "heavy-preview"})

    entries = list(project_tree.iter_entries())
    key, preview, metadata, is_lazy, resolver = entries[0]

    assert key == "lazy_block"
    assert is_lazy
    assert "heavy-preview" in str(preview)
    assert metadata["preview"] == "heavy-preview"
    assert calls == []

    assert resolver is not None
    resolved = resolver()
    assert isinstance(resolved, Tree)
    assert calls == ["loaded"]
    assert project_tree["lazy_block"]["values"][0] == 1


def test_observers_receive_events(project_tree: Tree):
    events: list[tuple[str, tuple[str, ...]]] = []
    project_tree.add_observer(lambda event, path, value: events.append((event, path)))

    project_tree["sample"] = 5
    project_tree.add_lazy("delayed", lambda: 9)
    _ = project_tree["delayed"]
    del project_tree["sample"]

    recorded = set(events)
    assert ("set", ("project", "sample")) in recorded
    assert ("set", ("project", "delayed")) in recorded
    assert ("resolve", ("project", "delayed")) in recorded
    assert ("delete", ("project", "sample")) in recorded
