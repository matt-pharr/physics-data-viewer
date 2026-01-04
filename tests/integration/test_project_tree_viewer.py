from __future__ import annotations

import pytest

from platform.gui.data_viewer import DataViewer
from platform.state.project_tree import Tree, get_project_tree


@pytest.fixture(autouse=True)
def project_tree():
    tree = get_project_tree()
    tree.reset(clear_observers=True)
    yield tree
    tree.reset(clear_observers=True)


def test_project_tree_backed_viewer_shows_nodes(project_tree: Tree):
    project_tree["constants"] = Tree({"pi": 3.14})

    loads: list[str] = []

    def loader() -> Tree:
        loads.append("load")
        branch = Tree()
        branch["samples"] = [0, 1, 2]
        return branch

    project_tree.add_lazy("waveforms", loader, metadata={"preview": "lazy-block"})

    viewer = DataViewer()
    root_children = {node.key: node for _, node in viewer.tree.iter_visible()}

    assert {"constants", "waveforms"}.issubset(root_children.keys())
    lazy_node = root_children["waveforms"]
    assert "lazy-block" in lazy_node.formatted.preview
    assert loads == []

    lazy_node.expand()
    assert loads == ["load"]
    nested_keys = {child.key for _, child in lazy_node.iter_visible()}
    assert "samples" in nested_keys
    assert project_tree.get_path(["waveforms", "samples"])[-1] == 2


def test_module_hook_writes_are_visible(project_tree: Tree):
    project_tree.set_path(["moduleA", "output"], {"energy": 9})

    viewer = DataViewer()
    target = viewer.tree.expand_path(("root", "moduleA", "output", "energy"))
    assert target is not None
    assert target.value == 9
